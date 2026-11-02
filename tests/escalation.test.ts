import { describe, expect, test } from "bun:test"
import { resolveConfig, DEFAULT_CONFIG, DEFAULT_RISK_POLICY } from "../src/config.ts"
import { applyEscalationDisposition, resolveEscalationDisposition } from "../src/escalation.ts"
import { enforceDecision } from "../src/decision.ts"
import type { ReviewExecutionResult, ReviewerConfig } from "../src/types.ts"
import { decision } from "./helpers.ts"

function cfg(overrides: Partial<ReviewerConfig> = {}): ReviewerConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    riskPolicy: {
      ...DEFAULT_RISK_POLICY,
      ...(overrides.riskPolicy ?? {}),
      allow: {
        ...DEFAULT_RISK_POLICY.allow,
        ...(overrides.riskPolicy?.allow ?? {}),
      },
    },
  }
}

function escalate(overrides: Partial<ReviewExecutionResult> = {}): ReviewExecutionResult {
  return {
    kind: "escalate",
    reason: "needs a human",
    decisionSource: "llm-reviewer",
    ...overrides,
  }
}

describe("escalation disposition helper", () => {
  test("default manual keeps escalate for human", () => {
    const result = applyEscalationDisposition(escalate(), cfg())
    expect(result.kind).toBe("escalate")
    expect(result.escalationDisposition).toBe("manual")
    // No structured decision → no invented reviewerOutcome.
    expect(result.reviewerOutcome).toBeUndefined()
    expect(result.decision).toBeUndefined()
  })

  test("escalationMode deny converts escalate to deny and preserves reason", () => {
    const result = applyEscalationDisposition(
      escalate({
        reason: "low confidence on medium risk",
        reviewerModel: "openai/gpt-5.6-luna",
        reviewerEscalatedFrom: {
          model: "opencode/jev-1.13-free",
          reason: "System One confidence was low.",
        },
      }),
      cfg({ escalationMode: "deny" }),
    )
    expect(result.kind).toBe("deny")
    expect(result.reason).toBe("low confidence on medium risk")
    expect(result.escalationDisposition).toBe("deny")
    // Fail-safe without structured decision must not invent risk/confidence.
    expect(result.reviewerOutcome).toBeUndefined()
    expect(result.decision).toBeUndefined()
    expect(result.reviewerModel).toBe("openai/gpt-5.6-luna")
    expect(result.reviewerEscalatedFrom?.model).toBe("opencode/jev-1.13-free")
  })

  test("deny escalation disposition preserves independent fallback metadata", () => {
    const result = applyEscalationDisposition(
      escalate({
        reviewerModel: "openrouter/typesafe/jev-1.13",
        fallbackFrom: "opencode/jev-1.13-free",
        fallbackReason: "rate-limited",
        fallbackAttempts: 3,
      }),
      cfg({ escalationMode: "deny" }),
    )
    expect(result.kind).toBe("deny")
    expect(result.reviewerModel).toBe("openrouter/typesafe/jev-1.13")
    expect(result.fallbackFrom).toBe("opencode/jev-1.13-free")
    expect(result.fallbackReason).toBe("rate-limited")
    expect(result.fallbackAttempts).toBe(3)
    expect(result.reviewerEscalatedFrom).toBeUndefined()
  })

  test("LLM escalate→deny keeps original decision.outcome escalate", () => {
    const llmEscalate = escalate({
      reason: "Ambiguous scope needs a human.",
      decision: decision("escalate", { rationale: "Ambiguous scope needs a human." }),
      reviewerOutcome: "escalate",
    })
    const result = applyEscalationDisposition(llmEscalate, cfg({ escalationMode: "deny" }))
    expect(result.kind).toBe("deny")
    expect(result.reviewerOutcome).toBe("escalate")
    expect(result.decision?.outcome).toBe("escalate")
    expect(result.decision?.rationale).toContain("Ambiguous scope")
    expect(result.escalationDisposition).toBe("deny")
  })

  test("allow and explicit deny pass through unchanged", () => {
    const allow: ReviewExecutionResult = {
      kind: "allow",
      reason: "ok",
      decision: decision("allow"),
      reviewerOutcome: "allow",
    }
    const deny: ReviewExecutionResult = {
      kind: "deny",
      reason: "no",
      decision: decision("deny"),
      reviewerOutcome: "deny",
    }
    expect(applyEscalationDisposition(allow, cfg({ escalationMode: "deny" }))).toEqual(allow)
    expect(applyEscalationDisposition(deny, cfg({ escalationMode: "deny" }))).toEqual(deny)
  })

  test("manual-superseded is never converted to deny", () => {
    const superseded = escalate({
      reason: "already answered",
      decisionSource: "manual-superseded",
    })
    const result = applyEscalationDisposition(superseded, cfg({ escalationMode: "deny" }))
    expect(result).toEqual(superseded)
    expect(resolveEscalationDisposition(superseded, cfg({ escalationMode: "deny" }))).toBe("manual")
  })

  test("onInvalidDecision deny hardens only invalid-decision category under manual mode", () => {
    const config = cfg({
      riskPolicy: { ...DEFAULT_RISK_POLICY, onInvalidDecision: "deny" },
    })
    const invalid = applyEscalationDisposition(escalate(), config, "invalid-decision")
    const general = applyEscalationDisposition(escalate(), config, "general")
    const failure = applyEscalationDisposition(escalate(), config, "reviewer-failure")
    expect(invalid.kind).toBe("deny")
    expect(general.kind).toBe("escalate")
    expect(failure.kind).toBe("escalate")
  })

  test("onReviewerFailure deny hardens only reviewer-failure category under manual mode", () => {
    const config = cfg({
      riskPolicy: { ...DEFAULT_RISK_POLICY, onReviewerFailure: "deny" },
    })
    const failure = applyEscalationDisposition(escalate(), config, "reviewer-failure")
    const invalid = applyEscalationDisposition(escalate(), config, "invalid-decision")
    expect(failure.kind).toBe("deny")
    expect(invalid.kind).toBe("escalate")
  })

  test("escalationMode deny supersedes category knobs left at manual", () => {
    const config = cfg({
      escalationMode: "deny",
      riskPolicy: {
        ...DEFAULT_RISK_POLICY,
        onInvalidDecision: "manual",
        onReviewerFailure: "manual",
      },
    })
    expect(applyEscalationDisposition(escalate(), config, "general").kind).toBe("deny")
    expect(applyEscalationDisposition(escalate(), config, "invalid-decision").kind).toBe("deny")
    expect(applyEscalationDisposition(escalate(), config, "reviewer-failure").kind).toBe("deny")
  })

  test("preserves original reviewerOutcome from gated allow→escalate", () => {
    const gated = enforceDecision(
      decision("allow", { confidence: 0.2 }),
      cfg({ confidenceThreshold: 0.7 }),
    )
    expect(gated.kind).toBe("escalate")
    expect(gated.reviewerOutcome).toBe("allow")
    const disposed = applyEscalationDisposition(gated, cfg({ escalationMode: "deny" }))
    expect(disposed.kind).toBe("deny")
    expect(disposed.reviewerOutcome).toBe("allow")
    expect(disposed.escalationDisposition).toBe("deny")
  })
})

describe("resolveConfig escalationMode", () => {
  test("defaults to manual", () => {
    expect(resolveConfig({}).escalationMode).toBe("manual")
  })

  test("accepts deny", () => {
    expect(resolveConfig({ escalationMode: "deny" }).escalationMode).toBe("deny")
  })

  test("invalid values fall back to manual", () => {
    expect(resolveConfig({ escalationMode: "auto" }).escalationMode).toBe("manual")
    expect(resolveConfig({ escalationMode: 1 }).escalationMode).toBe("manual")
  })
})
