import { describe, expect, test } from "bun:test"
import { APIError } from "@typesafe-ai/sdk"
import { resolveConfig } from "../src/config.ts"
import { ReviewAttempt } from "../src/core/review-attempt.ts"
import { SystemOneReviewerBackend, type SystemOneInvoke } from "../src/system-one/backend.ts"
import { SYSTEM_ONE_QUESTIONS } from "../src/system-one/review.ts"
import type { ReviewEnvelope, ReviewExecutionResult, ReviewerConfig } from "../src/types.ts"

const FREE = "opencode/jev-1.13-free"
const PAID = "openrouter/typesafe/jev-1.13"

function config(extra: Record<string, unknown> = {}): ReviewerConfig {
  return resolveConfig({
    model: FREE,
    systemOneFallback: { model: PAID },
    ...extra,
  })
}

function envelope(): ReviewEnvelope {
  return {
    request: {
      id: "req",
      sessionID: "ses",
      permission: "bash",
      patterns: ["printf ok"],
      metadata: { command: "printf ok" },
      always: [],
    },
    directory: "/workspace",
    worktree: "/workspace",
    transcript: "USER: Print ok",
    intentHistory: "Print ok",
    enrichment: "",
    sshAudit: [],
  }
}

function answer(model = "jev-1.13-free", outcome = "allow") {
  const picks: Record<string, string> = {
    outcome,
    risk_level: "low",
    user_authorization: "high",
    scope_alignment: "aligned",
    evidence_completeness: "sufficient",
    primary_basis: "authorized_routine",
  }
  const answers = Object.fromEntries(
    Object.entries(SYSTEM_ONE_QUESTIONS).map(([name, question]) => {
      if (question.type === "noul") {
        return [name, { type: "noul", noul: ["material_authorization", "within_intent_scope"].includes(name) ? 1 : 0 }]
      }
      const criteria = Object.keys(question.criteria)
      const choice = picks[name] ?? criteria[0]!
      return [
        name,
        {
          type: "choice",
          choice,
          confidence: 1,
          probabilities: Object.fromEntries(criteria.map((candidate) => [candidate, candidate === choice ? 1 : 0])),
        },
      ]
    }),
  )
  return { model, answers, usage: { input_tokens: 100, output_tokens: 0 } }
}

function http(status: number): APIError {
  return APIError.fromResponse(status, { error: "synthetic" }, new Headers())
}

function create(
  primary: SystemOneInvoke,
  paid: SystemOneInvoke,
  settings = config(),
  reasoning?: () => Promise<ReviewExecutionResult>,
) {
  return new SystemOneReviewerBackend(
    settings,
    reasoning ? async () => reasoning() : undefined,
    reasoning ? "openrouter/openai/gpt-6-luna" : undefined,
    primary,
    undefined,
    { model: PAID, invoke: paid },
  )
}

describe("System One paid transport fallback", () => {
  test("valid primary results never use paid fallback, even for a valid explicit escalation", async () => {
    for (const outcome of ["allow", "deny", "escalate"]) {
      let free = 0
      let paid = 0
      const backend = create(
        async () => { free++; return answer("jev-1.13-free", outcome) },
        async () => { paid++; return answer("typesafe/jev-1.13-20260917") },
      )
      const attempt = new ReviewAttempt("g", 8000)
      try {
        const result = await backend.review(envelope(), attempt)
        expect(free).toBe(1)
        expect(paid).toBe(0)
        expect(result.reviewerModel).toBe(FREE)
        expect(result.fallbackFrom).toBeUndefined()
        expect(result.decisionSource).toBe("system-one-reviewer")
      } finally { attempt.close("finished") }
    }
  })

  test("two retryable 503s then a valid free response never incur paid fallback", async () => {
    let free = 0
    let paid = 0
    const backend = create(
      async () => { if (++free < 3) throw http(503); return answer() },
      async () => { paid++; return answer("typesafe/jev-1.13-20260917") },
    )
    const attempt = new ReviewAttempt("g", 8000)
    try {
      const result = await backend.review(envelope(), attempt)
      expect(free).toBe(3)
      expect(paid).toBe(0)
      expect(result.kind).toBe("allow")
    } finally { attempt.close("finished") }
  })

  test("exhausted rate limits fall back once with correct model attribution", async () => {
    let free = 0
    let paid = 0
    const backend = create(
      async () => { free++; throw http(429) },
      async () => { paid++; return answer("typesafe/jev-1.13-20260917") },
    )
    const attempt = new ReviewAttempt("g", 8000)
    try {
      const result = await backend.review(envelope(), attempt)
      expect(free).toBe(3)
      expect(paid).toBe(1)
      expect(result.kind).toBe("allow")
      expect(result.reviewerModel).toBe(PAID)
      expect(result.fallbackFrom).toBe(FREE)
      expect(result.fallbackReason).toBe("rate-limited")
      expect(result.fallbackAttempts).toBe(3)
      expect(result.reviewerEscalatedFrom).toBeUndefined()
    } finally { attempt.close("finished") }
  })

  test("access and unavailable-endpoint failures fall back immediately", async () => {
    for (const status of [401, 402, 403, 404, 410]) {
      let free = 0
      let paid = 0
      const backend = create(
        async () => { free++; throw http(status) },
        async () => { paid++; return answer("typesafe/jev-1.13-20260917") },
      )
      const attempt = new ReviewAttempt("g", 8000)
      try {
        const result = await backend.review(envelope(), attempt)
        expect(free).toBe(1)
        expect(paid).toBe(1)
        expect(result.fallbackAttempts).toBe(1)
        expect(result.kind).toBe("allow")
      } finally { attempt.close("finished") }
    }
  })

  test("invalid request errors never pay to repeat a broken contract", async () => {
    for (const status of [400, 413, 422]) {
      let paid = 0
      const backend = create(
        async () => { throw http(status) },
        async () => { paid++; return answer("typesafe/jev-1.13-20260917") },
      )
      const attempt = new ReviewAttempt("g", 8000)
      try {
        const result = await backend.review(envelope(), attempt)
        expect(paid).toBe(0)
        expect(result.decisionSource).toBe("failure-safe")
        expect(result.kind).toBe("escalate")
        expect(result.reviewerModel).toBeUndefined()
      } finally { attempt.close("finished") }
    }
  })

  test("malformed and wrong-identity free responses retry and fall back", async () => {
    for (const invalid of [{ model: "other-model", answers: {} }, { ...answer(), answers: {} }]) {
      let free = 0
      const backend = create(
        async () => { free++; return invalid },
        async () => answer("typesafe/jev-1.13-20260917"),
      )
      const attempt = new ReviewAttempt("g", 8000)
      try {
        const result = await backend.review(envelope(), attempt)
        expect(free).toBe(3)
        expect(result.reviewerModel).toBe(PAID)
        expect(result.fallbackReason).toBe("invalid-response")
      } finally { attempt.close("finished") }
    }
  })

  test("a malformed paid result cannot auto-approve; fallback provenance remains", async () => {
    const backend = create(
      async () => { throw http(401) },
      async () => ({ model: "wrong", answers: {} }),
    )
    const attempt = new ReviewAttempt("g", 8000)
    try {
      const result = await backend.review(envelope(), attempt)
      expect(result.kind).toBe("escalate")
      expect(result.decisionSource).toBe("failure-safe")
      expect(result.reviewerModel).toBeUndefined()
      expect(result.fallbackReason).toBe("access-unavailable")
    } finally { attempt.close("finished") }
  })

  test("missing paid credentials fail safely without calling Luna", async () => {
    let luna = 0
    const backend = create(
      async () => { throw http(403) },
      async () => { throw new Error("No active OpenRouter connection") },
      config(),
      async () => { luna++; return { kind: "allow", reason: "unexpected" } },
    )
    const attempt = new ReviewAttempt("g", 8000)
    try {
      const result = await backend.review(envelope(), attempt)
      expect(result.decisionSource).toBe("failure-safe")
      expect(result.kind).toBe("escalate")
      expect(luna).toBe(0)
      expect(result.fallbackFrom).toBe(FREE)
    } finally { attempt.close("finished") }
  })

  test("valid difficult paid responses retain both fallback and Luna provenance", async () => {
    let luna = 0
    const backend = create(
      async () => { throw http(401) },
      async () => answer("typesafe/jev-1.13-20260917", "escalate"),
      config(),
      async () => { luna++; return { kind: "deny", reason: "Reasoning denial", decisionSource: "llm-reviewer" } },
    )
    const attempt = new ReviewAttempt("g", 8000)
    try {
      // A clear (confidence 1) explicit escalation remains manual.
      const result = await backend.review(envelope(), attempt)
      expect(result.kind).toBe("escalate")
      expect(result.reviewerModel).toBe(PAID)
      expect(result.fallbackFrom).toBe(FREE)
      expect(luna).toBe(0)
    } finally { attempt.close("finished") }
  })

  test("cancellation during retry backoff prevents paid requests", async () => {
    let free = 0
    let paid = 0
    const backend = create(
      async () => { free++; throw http(503) },
      async () => { paid++; return answer("typesafe/jev-1.13-20260917") },
    )
    const attempt = new ReviewAttempt("g", 8000)
    const pending = backend.review(envelope(), attempt)
    await new Promise((resolve) => setTimeout(resolve, 30))
    attempt.close("cancelled")
    const result = await pending
    expect(result.decisionSource).toBe("failure-safe")
    expect(result.kind).toBe("escalate")
    expect(free).toBe(1)
    expect(paid).toBe(0)
  })

  test("no trusted fallback preserves primary-only failure-safe behavior", async () => {
    let paid = 0
    const backend = create(
      async () => { throw http(503) },
      async () => { paid++; return answer("typesafe/jev-1.13-20260917") },
      resolveConfig({ model: FREE }),
    )
    const attempt = new ReviewAttempt("g", 8000)
    try {
      const result = await backend.review(envelope(), attempt)
      expect(paid).toBe(0)
      expect(result.decisionSource).toBe("failure-safe")
    } finally { attempt.close("finished") }
  })
})
