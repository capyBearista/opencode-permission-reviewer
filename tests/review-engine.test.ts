import { describe, expect, test } from "bun:test"
import { analyzeCapability } from "../src/capability/bash-analyzer.ts"
import { parseCommand } from "../src/capability/command-parser.ts"
import { enforceDecision } from "../src/decision.ts"
import { evaluateReview, type ReviewEnginePorts } from "../src/core/review-engine.ts"
import type {
  PermissionRequest,
  PolicyRule,
  ReviewEnvelope,
  ReviewExecutionResult,
} from "../src/types.ts"
import { config, decision, request } from "./helpers.ts"

const DIR = "/workspace/project"

function bash(command: string): PermissionRequest {
  return request({ permission: "bash", patterns: [command], metadata: { command } })
}

function envelope(req: PermissionRequest, overrides: Partial<ReviewEnvelope> = {}): ReviewEnvelope {
  const command = String(req.metadata.command ?? "")
  return {
    request: req,
    directory: DIR,
    worktree: DIR,
    transcript: "",
    intentHistory: "",
    enrichment: "",
    sshAudit: [],
    capability: analyzeCapability(parseCommand(command), DIR, DIR),
    ...overrides,
  }
}

const allow = (): ReviewExecutionResult => ({
  kind: "allow",
  reason: "Looks fine.",
  decision: decision("allow"),
  decisionSource: "llm-reviewer",
})

/** Fake host ports that record every call so tests can prove what was skipped. */
function ports(
  options: {
    envelope?: (req: PermissionRequest) => ReviewEnvelope
    review?: (envelope: ReviewEnvelope) => ReviewExecutionResult | Promise<ReviewExecutionResult>
    active?: () => boolean
    auxiliary?: (sessionID: string) => boolean
  } = {},
) {
  const calls = { collect: 0, review: 0, observed: [] as ReviewEnvelope[] }
  const port: ReviewEnginePorts = {
    collect: async (req) => {
      calls.collect++
      return (options.envelope ?? envelope)(req)
    },
    review: async (evidence) => {
      calls.review++
      return (options.review ?? allow)(evidence)
    },
    active: options.active ?? (() => true),
    auxiliarySession: options.auxiliary ?? (() => false),
    observe: (evidence) => {
      calls.observed.push(evidence)
    },
  }
  return { port, calls }
}

const rule = (effect: PolicyRule["effect"], actionClass: string[] = ["read-only"]): PolicyRule =>
  ({
    id: `${effect}-rule`,
    source: "global",
    when: { actionClass } as PolicyRule["when"],
    effect,
    reason: `test ${effect} rule`,
  }) as PolicyRule

describe("review engine pre-model gates", () => {
  test("a request already answered manually is superseded before any work", async () => {
    const { port, calls } = ports({ active: () => false })
    const result = await evaluateReview(request(), config(), port)
    expect(result).toMatchObject({ kind: "escalate", decisionSource: "manual-superseded" })
    expect(calls).toMatchObject({ collect: 0, review: 0 })
  })

  test("reviewer sessions requesting permissions are denied critically without a model call", async () => {
    const { port, calls } = ports({ auxiliary: (id) => id === "ses_reviewer" })
    const result = await evaluateReview(request({ sessionID: "ses_reviewer" }), config(), port)
    expect(result).toMatchObject({
      kind: "deny",
      decisionSource: "emergency-brake",
      decision: { risk_level: "critical" },
    })
    expect(result.reason).toContain("Automatic reviewer sessions may not request")
    expect(calls).toMatchObject({ collect: 0, review: 0 })
    const other = await evaluateReview(request({ sessionID: "ses_main" }), config(), port)
    expect(other.kind).toBe("allow")
  })

  test("the emergency brake denies critical destruction before evidence or model", async () => {
    const { port, calls } = ports()
    const result = await evaluateReview(bash("rm -rf /"), config(), port)
    expect(result).toMatchObject({ kind: "deny", decisionSource: "emergency-brake" })
    expect(result.decision?.risk_level).toBe("critical")
    expect(calls).toMatchObject({ collect: 0, review: 0 })
  })

  test("wrapper nesting beyond the lexer budget is denied before any model call", async () => {
    const { port, calls } = ports()
    const result = await evaluateReview(bash(`${"env -S ".repeat(33)}rm -rf /`), config(), port)
    expect(result.kind).toBe("deny")
    expect(result.reason).toContain("exceeded the static analysis budget")
    expect(calls).toMatchObject({ collect: 0, review: 0 })
  })

  test("a wide command past the effective-command budget never reaches the model", async () => {
    const wide = Array.from({ length: 9_000 }, (_, i) => `echo segment-${i}`).join(";")
    const { port, calls } = ports()
    const result = await evaluateReview(bash(wide), config(), port)
    expect(result.kind).toBe("deny")
    expect(result.reason).toContain("exceeded the static analysis budget")
    expect(calls).toMatchObject({ collect: 0, review: 0 })
  })

  test("an evidence preflight denial is a non-emergency deny that skips the model", async () => {
    const { port, calls } = ports({
      envelope: (req) => envelope(req, { preflightDenial: "Remote stdin is missing." }),
    })
    const result = await evaluateReview(bash("printf safe"), config(), port)
    expect(result).toMatchObject({ kind: "deny", reason: "Remote stdin is missing." })
    expect(result.decisionSource).toBe("deterministic-policy")
    expect(result.decision?.risk_level).toBe("high")
    expect(calls).toMatchObject({ collect: 1, review: 0 })
  })

  test("a manual answer during evidence collection skips the model call", async () => {
    let live = true
    const { port, calls } = ports({
      active: () => live,
      envelope: (req) => {
        live = false
        return envelope(req)
      },
    })
    const result = await evaluateReview(bash("printf safe"), config(), port)
    expect(result.decisionSource).toBe("manual-superseded")
    expect(calls.review).toBe(0)
  })

  test("a manual answer during the model call supersedes allow, deny and escalate", async () => {
    for (const kind of ["allow", "deny", "escalate"] as const) {
      let live = true
      const { port } = ports({
        active: () => live,
        review: () => {
          live = false
          return { kind, reason: "late", decisionSource: "llm-reviewer" }
        },
      })
      const result = await evaluateReview(bash("printf safe"), config(), port)
      expect(result).toMatchObject({ kind: "escalate", decisionSource: "manual-superseded" })
    }
  })

  test("manual supersede wins under escalationMode deny", async () => {
    const { port } = ports({ active: () => false })
    const result = await evaluateReview(request(), config({ escalationMode: "deny" }), port)
    expect(result.kind).toBe("escalate")
    expect(result.decisionSource).toBe("manual-superseded")
  })
})

describe("review engine declarative policy routing", () => {
  const readOnly = bash("echo safe")

  test("enforce mode with a deny rule skips the reviewer and denies", async () => {
    const { port, calls } = ports()
    const result = await evaluateReview(
      readOnly,
      config({ enforcementMode: "enforce", policyRules: [rule("deny")] }),
      port,
    )
    expect(result.kind).toBe("deny")
    expect(result.reason).toContain("Declarative policy route: deny")
    expect(result.reason).toContain("test deny rule")
    expect(calls.review).toBe(0)
  })

  test("enforce mode with a manual rule skips the reviewer and escalates to a human", async () => {
    const { port, calls } = ports()
    const result = await evaluateReview(
      readOnly,
      config({ enforcementMode: "enforce", policyRules: [rule("manual")] }),
      port,
    )
    expect(result).toMatchObject({
      kind: "escalate",
      decisionSource: "deterministic-policy",
      escalationDisposition: "manual",
    })
    expect(result.reason).toContain("Declarative policy route: manual")
    expect(calls.review).toBe(0)
  })

  test("a policy manual route becomes a deny under escalationMode deny", async () => {
    const { port, calls } = ports()
    const result = await evaluateReview(
      readOnly,
      config({ enforcementMode: "enforce", escalationMode: "deny", policyRules: [rule("manual")] }),
      port,
    )
    expect(result).toMatchObject({ kind: "deny", escalationDisposition: "deny" })
    // No structured decision existed, so none is invented.
    expect(result.reviewerOutcome).toBeUndefined()
    expect(result.decision).toBeUndefined()
    expect(calls.review).toBe(0)
  })

  test("enforce mode whose rules do not match still reviews", async () => {
    const { port, calls } = ports()
    const result = await evaluateReview(
      readOnly,
      config({ enforcementMode: "enforce", policyRules: [rule("deny", ["destruction"])] }),
      port,
    )
    expect(result.kind).toBe("allow")
    expect(calls.review).toBe(1)
  })

  test("observe mode records the counterfactual route but still reviews", async () => {
    const { port, calls } = ports()
    const result = await evaluateReview(
      readOnly,
      config({ enforcementMode: "observe", policyRules: [rule("deny")] }),
      port,
    )
    expect(result.kind).toBe("allow")
    expect(calls.review).toBe(1)
    const evidence = calls.observed[0]!
    expect(evidence.policyTrace).toMatchObject({ mode: "observe", finalRoute: "deny" })
    expect(evidence.policyTrace?.matchedRules.map((m) => m.id)).toEqual(["deny-rule"])
    expect(evidence.policyTrace?.effectivePolicyHash).toHaveLength(16)
  })

  test("the policy trace is attached to the evidence the reviewer receives", async () => {
    let seen: ReviewEnvelope | undefined
    const { port } = ports({
      review: (evidence) => {
        seen = evidence
        return allow()
      },
    })
    await evaluateReview(readOnly, config(), port)
    expect(seen?.policyTrace).toMatchObject({ mode: "observe", finalRoute: "review" })
  })

  test("a malformed rule is dropped instead of crashing or blocking review", async () => {
    const bad = {
      id: "bad-rule",
      source: "global",
      when: { actionClass: 42 },
      effect: "deny",
      reason: "should be dropped",
    } as unknown as PolicyRule
    const { port, calls } = ports()
    const result = await evaluateReview(
      readOnly,
      config({ enforcementMode: "enforce", policyRules: [bad] }),
      port,
    )
    expect(result.kind).toBe("allow")
    expect(calls.review).toBe(1)
  })
})

describe("review engine allow gates", () => {
  const safe = bash("printf safe")

  test("a command whose static analysis was truncated never reaches the model", async () => {
    const truncated = (req: PermissionRequest) =>
      envelope(req, {
        parsedCommand: { ...parseCommand("printf safe"), analysisTruncated: true },
      })
    const { port, calls } = ports({ envelope: truncated })
    const result = await evaluateReview(safe, config(), port)
    expect(result).toMatchObject({
      kind: "escalate",
      decisionSource: "deterministic-policy",
      escalationDisposition: "manual",
    })
    expect(result.reason).toContain("static analysis depth or expansion budget")
    expect(calls.review).toBe(0)

    const hardened = ports({ envelope: truncated })
    const denied = await evaluateReview(safe, config({ escalationMode: "deny" }), hardened.port)
    expect(denied.kind).toBe("deny")
    expect(hardened.calls.review).toBe(0)
  })

  test("a degraded reviewer config blocks a model allow and keeps its decision", async () => {
    const { port } = ports()
    const result = await evaluateReview(safe, config({ configDegraded: ["bad policy rule"] }), port)
    expect(result.kind).toBe("escalate")
    expect(result.reason).toContain("Automatic approval is disabled")
    expect(result.reason).toContain("bad policy rule")
    expect(result.decisionSource).toBe("deterministic-policy")
    expect(result.decision?.outcome).toBe("allow")
    expect(result.reviewerOutcome).toBe("allow")
  })

  test("a degraded config under escalationMode deny turns the allow into a deny", async () => {
    const { port } = ports()
    const result = await evaluateReview(
      safe,
      config({ configDegraded: ["bad"], escalationMode: "deny" }),
      port,
    )
    expect(result).toMatchObject({ kind: "deny", escalationDisposition: "deny" })
  })

  test("an empty degraded list does not block approval", async () => {
    const { port } = ports()
    expect((await evaluateReview(safe, config({ configDegraded: [] }), port)).kind).toBe("allow")
  })

  test("an allow over elided action evidence escalates instead", async () => {
    const { port } = ports({
      envelope: (req) => envelope(req, { actionEvidenceComplete: false }),
    })
    const result = await evaluateReview(safe, config(), port)
    expect(result.kind).toBe("escalate")
    expect(result.reason).toContain("elided or truncated")
    expect(result.decisionSource).toBe("deterministic-policy")
  })

  test("a degraded config does not hide a model deny", async () => {
    const { port } = ports({
      review: () => ({ kind: "deny", reason: "unsafe", decisionSource: "llm-reviewer" }),
    })
    const result = await evaluateReview(safe, config({ configDegraded: ["bad"] }), port)
    expect(result).toMatchObject({ kind: "deny", reason: "unsafe" })
  })
})

describe("review engine escalationMode", () => {
  const insufficientEvidence = decision("allow", {
    risk_level: "medium",
    evidence_completeness: "insufficient",
  })
  const safe = bash("printf safe")
  const escalated = (overrides: Partial<ReviewExecutionResult> = {}): ReviewExecutionResult => ({
    kind: "escalate",
    reason: "reviewer is unsure",
    decisionSource: "llm-reviewer",
    ...overrides,
  })

  test("deny mode converts an escalate to a deny with the original rationale", async () => {
    const { port } = ports({
      review: () => escalated({ decision: decision("escalate", { rationale: "ambiguous scope" }) }),
    })
    const result = await evaluateReview(safe, config({ escalationMode: "deny" }), port)
    expect(result).toMatchObject({
      kind: "deny",
      reason: "reviewer is unsure",
      escalationDisposition: "deny",
      reviewerOutcome: "escalate",
    })
  })

  test("the default manual mode leaves an escalate pending for a human", async () => {
    const { port } = ports({ review: () => escalated() })
    const result = await evaluateReview(safe, config(), port)
    expect(result).toMatchObject({ kind: "escalate", escalationDisposition: "manual" })
  })

  test("low confidence becomes a deny under deny mode", async () => {
    const hardened = config({ escalationMode: "deny" })
    const { port } = ports({
      review: () => enforceDecision(decision("allow", { confidence: 0.05 }), hardened),
    })
    const result = await evaluateReview(safe, hardened, port)
    expect(result).toMatchObject({ kind: "deny", escalationDisposition: "deny" })
    expect(result.reviewerOutcome).toBe("allow")
  })

  test("insufficient evidence becomes a deny under deny mode", async () => {
    const hardened = config({ escalationMode: "deny" })
    const { port } = ports({
      review: () => enforceDecision(insufficientEvidence, hardened),
    })
    const result = await evaluateReview(safe, hardened, port)
    expect(result.reason).toContain("evidence insufficient")
    expect(result.kind).toBe("deny")
    expect(result.escalationDisposition).toBe("deny")
  })

  test("low confidence and insufficient evidence escalate to a human by default", async () => {
    for (const gated of [decision("allow", { confidence: 0.05 }), insufficientEvidence]) {
      const { port } = ports({ review: () => enforceDecision(gated, config()) })
      const result = await evaluateReview(safe, config(), port)
      expect(result.kind).toBe("escalate")
    }
  })

  test("reviewer failures and invalid output deny fail-closed under deny mode", async () => {
    for (const reason of ["Reviewer timed out", "Reviewer returned invalid structured output"]) {
      const { port } = ports({
        review: () => ({ kind: "escalate", reason, decisionSource: "failure-safe" }),
      })
      const result = await evaluateReview(safe, config({ escalationMode: "deny" }), port)
      expect(result).toMatchObject({ kind: "deny", reason, escalationDisposition: "deny" })
      expect(result.decision).toBeUndefined()
      expect(result.reviewerOutcome).toBeUndefined()
    }
  })

  test("an explicit allow stays allow and an explicit deny stays deny", async () => {
    const hardened = config({ escalationMode: "deny" })
    const allowed = await evaluateReview(safe, hardened, ports().port)
    expect(allowed.kind).toBe("allow")
    expect(allowed.escalationDisposition).toBeUndefined()
    const denied = await evaluateReview(
      safe,
      hardened,
      ports({
        review: () => ({
          kind: "deny",
          reason: "unsafe",
          decision: decision("deny"),
          decisionSource: "llm-reviewer",
        }),
      }).port,
    )
    expect(denied).toMatchObject({ kind: "deny", reason: "unsafe" })
    expect(denied.escalationDisposition).toBeUndefined()
  })
})

describe("review engine SSH script guidance", () => {
  const sshCommand = "ssh host 'bash -s' < script.sh"

  test("an unavailable verified script adds hash-checked command guidance to a non-allow", async () => {
    const { port } = ports({
      envelope: (req) =>
        envelope(req, {
          verifiedScript: { status: "unavailable" } as NonNullable<
            ReviewEnvelope["verifiedScript"]
          >,
        }),
      review: () => ({ kind: "escalate", reason: "Cannot judge.", decisionSource: "llm-reviewer" }),
    })
    const result = await evaluateReview(bash(sshCommand), config(), port)
    expect(result.reason).toContain("Cannot judge.")
    expect(result.reason).toContain("script command --file PATH --host HOST")
  })

  test("guidance is not added to an allow or a non-ssh command", async () => {
    const unavailable = (req: PermissionRequest) =>
      envelope(req, {
        verifiedScript: { status: "unavailable" } as NonNullable<ReviewEnvelope["verifiedScript"]>,
      })
    const allowed = await evaluateReview(
      bash(sshCommand),
      config(),
      ports({ envelope: unavailable }).port,
    )
    expect(allowed.reason).toBe("Looks fine.")
    const local = await evaluateReview(
      bash("printf safe"),
      config(),
      ports({
        envelope: unavailable,
        review: () => ({ kind: "deny", reason: "No.", decisionSource: "llm-reviewer" }),
      }).port,
    )
    expect(local.reason).toBe("No.")
  })
})
