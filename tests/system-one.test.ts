import { describe, expect, test } from "bun:test"
import { resolveConfig, isSystemOneReviewerModel } from "../src/config.ts"
import {
  enforceParsedSystemOneReview,
  enforceSystemOneDecision,
  parseSystemOneReview,
  SYSTEM_ONE_QUESTIONS,
} from "../src/system-one/review.ts"

const choice = (selected: string, keys: string[], confidence = 1) => {
  const remainder = (1 - confidence) / (keys.length - 1)
  return {
    type: "choice",
    choice: selected,
    confidence,
    probabilities: Object.fromEntries(
      keys.map((key) => [key, key === selected ? confidence : remainder]),
    ),
  }
}

function response(overrides: Record<string, unknown> = {}) {
  const answers: Record<string, unknown> = {
    outcome: choice("allow", ["allow", "deny", "escalate"]),
    risk_level: choice("low", ["low", "medium", "high", "critical"]),
    user_authorization: choice("high", ["high", "medium", "low", "unknown"]),
    scope_alignment: choice("aligned", ["aligned", "partial", "misaligned", "unknown"]),
    evidence_completeness: choice("sufficient", [
      "sufficient",
      "partial",
      "insufficient",
      "unknown",
    ]),
    primary_basis: choice("authorized_routine", [
      "authorized_routine",
      "authorized_reversible_change",
      "insufficient_authorization",
      "scope_mismatch",
      "insufficient_evidence",
      "destructive_effect",
      "credential_or_private_data",
      "security_or_privilege_change",
      "external_or_remote_effect",
      "trusted_policy_restriction",
      "conflicting_evidence",
    ]),
    material_authorization: { type: "noul", noul: 1 },
    within_intent_scope: { type: "noul", noul: 1 },
    unauthorized_data_loss: { type: "noul", noul: 0 },
    untrusted_sensitive_disclosure: { type: "noul", noul: 0 },
    excessive_credential_access: { type: "noul", noul: 0 },
    unauthorized_security_change: { type: "noul", noul: 0 },
    unauthorized_external_mutation: { type: "noul", noul: 0 },
    essential_evidence_missing: { type: "noul", noul: 0 },
    absolute_policy_deny: { type: "noul", noul: 0 },
    ...overrides,
  }
  return { model: "jev-1.13-free", answers, usage: { input_tokens: 10, output_tokens: 0 } }
}

describe("System One reviewer", () => {
  test("selects only known Jev providers and model IDs", () => {
    expect(isSystemOneReviewerModel("opencode/jev-1.13-free")).toBe(true)
    expect(isSystemOneReviewerModel("typesafe-ai/jev-latest")).toBe(true)
    expect(isSystemOneReviewerModel("openrouter/typesafe/jev-1.13")).toBe(false)
    expect(isSystemOneReviewerModel("commandcode/typesafe/jev")).toBe(true)
    expect(isSystemOneReviewerModel("commandcode/jev-1.13")).toBe(false)
    expect(isSystemOneReviewerModel("commandcode/typesafe/other")).toBe(false)
    expect(isSystemOneReviewerModel("other/jev-1.13")).toBe(false)
    expect(isSystemOneReviewerModel("opencode/not-jev")).toBe(false)
  })

  test("rejects an unexpected returned model from Command Code", () => {
    const config = { ...resolveConfig(undefined), model: "commandcode/typesafe/jev" }
    expect(parseSystemOneReview({ ...response(), model: "jev-1.13" }, config)).toBeUndefined()
  })

  test("builds a complete fixed question set", () => {
    expect(Object.keys(SYSTEM_ONE_QUESTIONS)).toHaveLength(15)
    expect(SYSTEM_ONE_QUESTIONS.outcome.type).toBe("choice")
    expect(SYSTEM_ONE_QUESTIONS.absolute_policy_deny.type).toBe("noul")
  })

  test("accepts a confident and internally consistent allow", () => {
    const config = { ...resolveConfig(undefined), model: "opencode/jev-1.13-free" }
    const parsed = parseSystemOneReview(response(), config)
    expect(parsed?.difficultReason).toBeUndefined()
    expect(parsed?.decision).toMatchObject({
      outcome: "allow",
      risk_level: "low",
      confidence: 1,
      rationale: "The action is routine, narrow, and adequately authorized.",
    })
  })

  test("escalates a low-confidence deny instead of trusting it", () => {
    const config = { ...resolveConfig(undefined), model: "opencode/jev-1.13-free" }
    const parsed = parseSystemOneReview(
      response({
        outcome: choice("deny", ["allow", "deny", "escalate"], 0.35),
        risk_level: choice("high", ["low", "medium", "high", "critical"]),
        primary_basis: choice("destructive_effect", [
          "authorized_routine",
          "authorized_reversible_change",
          "insufficient_authorization",
          "scope_mismatch",
          "insufficient_evidence",
          "destructive_effect",
          "credential_or_private_data",
          "security_or_privilege_change",
          "external_or_remote_effect",
          "trusted_policy_restriction",
          "conflicting_evidence",
        ]),
        unauthorized_data_loss: { type: "noul", noul: 1 },
      }),
      config,
    )
    expect(parsed?.decision.outcome).toBe("deny")
    expect(parsed?.difficultReason).toContain("below 0.40")
  })

  test("uses outcome confidence instead of the weakest descriptive field", () => {
    const config = { ...resolveConfig(undefined), model: "opencode/jev-1.13-free" }
    const parsed = parseSystemOneReview(
      response({
        evidence_completeness: choice(
          "sufficient",
          ["sufficient", "partial", "insufficient", "unknown"],
          0.31,
        ),
      }),
      config,
    )
    expect(parsed?.decision.confidence).toBe(1)
    expect(parsed?.difficultReason).toBeUndefined()
  })

  test("requires strong outcome confidence to allow with incomplete evidence", () => {
    const config = { ...resolveConfig(undefined), model: "opencode/jev-1.13-free" }
    const parsed = parseSystemOneReview(
      response({
        outcome: choice("allow", ["allow", "deny", "escalate"], 0.62),
        evidence_completeness: choice("partial", [
          "sufficient",
          "partial",
          "insufficient",
          "unknown",
        ]),
      }),
      config,
    )
    expect(parsed?.difficultReason).toContain("incomplete evidence")
  })

  test("recommends reasoning only when an explicit escalation is plausibly resolvable", () => {
    const config = { ...resolveConfig(undefined), model: "opencode/jev-1.13-free" }
    const strict = {
      ...resolveConfig({ systemOneReasoningThreshold: 0.5 }),
      model: "opencode/jev-1.13-free",
    }
    const clear = parseSystemOneReview(
      response({ outcome: choice("escalate", ["allow", "deny", "escalate"]) }),
      config,
    )
    const ambiguous = parseSystemOneReview(
      response({ outcome: choice("escalate", ["allow", "deny", "escalate"], 0.6) }),
      config,
    )
    expect(clear?.reasoningRecommended).toBe(false)
    expect(ambiguous?.reasoningRecommended).toBe(true)
    expect(
      parseSystemOneReview(
        response({ outcome: choice("escalate", ["allow", "deny", "escalate"], 0.6) }),
        strict,
      )?.reasoningRecommended,
    ).toBe(false)
  })

  test("preserves a valid deny even when its confidence marks it difficult", () => {
    const config = { ...resolveConfig(undefined), model: "opencode/jev-1.13-free" }
    const parsed = parseSystemOneReview(
      response({
        outcome: choice("deny", ["allow", "deny", "escalate"], 0.35),
        risk_level: choice("high", ["low", "medium", "high", "critical"]),
        primary_basis: choice("destructive_effect", [
          "authorized_routine",
          "authorized_reversible_change",
          "insufficient_authorization",
          "scope_mismatch",
          "insufficient_evidence",
          "destructive_effect",
          "credential_or_private_data",
          "security_or_privilege_change",
          "external_or_remote_effect",
          "trusted_policy_restriction",
          "conflicting_evidence",
        ]),
      }),
      config,
    )
    expect(parsed?.difficultReason).toContain("below 0.40")
    expect(enforceParsedSystemOneReview(parsed!, config).kind).toBe("deny")
  })

  test("does not reapply chat-model confidence floors after reconciliation", () => {
    const config = { ...resolveConfig(undefined), model: "opencode/jev-1.13-free" }
    const parsed = parseSystemOneReview(
      response({ outcome: choice("allow", ["allow", "deny", "escalate"], 0.55) }),
      config,
    )
    expect(parsed?.difficultReason).toBeUndefined()
    expect(enforceSystemOneDecision(parsed!.decision, config).kind).toBe("allow")
  })

  test("treats an unsafe allow signal as a difficult contradiction", () => {
    const config = { ...resolveConfig(undefined), model: "opencode/jev-1.13-free" }
    const parsed = parseSystemOneReview(
      response({ untrusted_sensitive_disclosure: { type: "noul", noul: 0.85 } }),
      config,
    )
    expect(parsed?.difficultReason).toContain("material safety signal")
  })

  test("rejects a choice that is not the most probable option", () => {
    const config = { ...resolveConfig(undefined), model: "opencode/jev-1.13-free" }
    const raw = response()
    raw.answers.outcome = {
      type: "choice",
      choice: "allow",
      confidence: 0.6,
      probabilities: { allow: 0.05, deny: 0.9, escalate: 0.05 },
    }
    expect(parseSystemOneReview(raw, config)).toBeUndefined()
  })
})
