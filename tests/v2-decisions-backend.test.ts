import { expect, test } from "bun:test"
import type { OpenCodeClient } from "@opencode/client"
import { resolveConfig } from "../src/config.ts"
import { ReviewAttempt } from "../src/core/review-attempt.ts"
import { DecisionsReviewerBackend } from "../src/system-one/decisions-backend.ts"
import { SYSTEM_ONE_QUESTIONS } from "../src/system-one/review.ts"
import type {
  DecisionAttemptRecord,
  DecisionsRouteTrace,
  DecisionsSelection,
} from "../src/system-one/decisions-router.ts"
import {
  DecisionsTransportError,
  type DecisionsTransport,
} from "../src/system-one/decisions-transport.ts"
import type { ReviewEnvelope, ReviewExecutionResult, ReviewerConfig } from "../src/types.ts"
import { decision as reviewerDecision, request } from "./helpers.ts"

function systemOneResponse(
  model: string,
  options: { outcome?: string; basis?: string; confidence?: number } = {},
) {
  const selected: Record<string, string> = {
    outcome: options.outcome ?? "allow",
    risk_level: "low",
    user_authorization: "high",
    scope_alignment: "aligned",
    evidence_completeness: "sufficient",
    primary_basis: options.basis ?? "authorized_routine",
  }
  return {
    model,
    usage: { input_tokens: 20, output_tokens: 0 },
    answers: Object.fromEntries(
      Object.entries(SYSTEM_ONE_QUESTIONS).map(([name, question]) => {
        if (question.type === "noul") {
          return [
            name,
            {
              type: "noul",
              noul: ["material_authorization", "within_intent_scope"].includes(name) ? 1 : 0,
            },
          ]
        }
        const values = Object.keys(question.criteria)
        const chosen = selected[name]!
        return [
          name,
          {
            type: "choice",
            choice: chosen,
            confidence: options.confidence ?? 1,
            probabilities: Object.fromEntries(
              values.map((value) => [value, value === chosen ? 1 : 0]),
            ),
          },
        ]
      }),
    ),
  }
}

function envelope(): ReviewEnvelope {
  return {
    request: request(),
    directory: "/workspace",
    worktree: "/workspace",
    transcript: "Run printf safe",
    intentHistory: "Run printf safe",
    enrichment: "",
    sshAudit: [],
  }
}

function config(overrides: Record<string, unknown> = {}): ReviewerConfig {
  return resolveConfig(
    {
      decisionMaxAttempts: 1,
      reasoningModels: [],
      ...overrides,
    },
    "v2",
  )
}

function backend(
  resolved: ReviewerConfig,
  transport: DecisionsTransport,
  reasoning?: {
    model: string
    review: (
      envelope: ReviewEnvelope,
      attempt: ReviewAttempt,
      client: OpenCodeClient,
    ) => Promise<import("../src/types.ts").ReviewExecutionResult>
  },
) {
  return new DecisionsReviewerBackend({
    config: resolved,
    transport,
    ...(reasoning === undefined ? {} : { reasoning }),
  })
}

test("selects the first parser-valid configured route and projects the bounded trace onto the envelope", async () => {
  const calls: string[] = []
  const transport: DecisionsTransport = async (request) => {
    request.onRequestSent()
    calls.push(request.model)
    if (request.model === "opencode/jev-1.13-free") return systemOneResponse("wrong/model")
    return systemOneResponse("vendor/valid")
  }
  const reviewer = backend(
    config({
      decisionModels: ["opencode/jev-1.13-free", "openrouter/vendor/valid"],
    }),
    transport,
  )
  const attempt = new ReviewAttempt("generation", 8_000)
  const review = envelope()

  try {
    const result = await reviewer.review(review, attempt, {} as OpenCodeClient)
    expect(result.kind).toBe("allow")
    expect(calls).toEqual(["opencode/jev-1.13-free", "openrouter/vendor/valid"])
    expect(review.decisionTrace).toMatchObject({
      reviewerModel: "openrouter/vendor/valid",
      responseModel: "vendor/valid",
      attempts: [
        { model: "opencode/jev-1.13-free", outcome: "invalid-decision" },
        {
          model: "openrouter/vendor/valid",
          outcome: "valid-decision",
          responseModel: "vendor/valid",
        },
      ],
    })
    expect(result.decisionAttempts).toEqual(review.decisionTrace?.attempts)
    expect(result.reviewerModel).toBe("openrouter/vendor/valid")
    expect(result.responseModel).toBe("vendor/valid")
  } finally {
    attempt.close("finished")
    await reviewer.waitForIdle()
  }
})

test("parser-valid deny, low-confidence, and contradictory decisions stop routing", async () => {
  const cases = [
    { name: "deny", response: systemOneResponse("jev-1.13-free", { outcome: "deny" }) },
    {
      name: "low confidence",
      response: systemOneResponse("jev-1.13-free", { confidence: 0.1 }),
    },
    {
      name: "contradictory",
      response: systemOneResponse("jev-1.13-free", { basis: "destructive_effect" }),
    },
  ]

  for (const testCase of cases) {
    let requests = 0
    let reasoningCalls = 0
    const transport: DecisionsTransport = async (request) => {
      request.onRequestSent()
      requests++
      return testCase.response
    }
    const reviewer = backend(
      config({
        decisionModels: ["opencode/jev-1.13-free", "openrouter/vendor/second"],
        reasoningModels: [
          {
            model: "openrouter/vendor/reasoning",
            variant: "fast",
            outputFormat: "text",
            timeoutMs: 30_000,
          },
        ],
      }),
      transport,
      {
        model: "openrouter/vendor/reasoning",
        review: async () => {
          reasoningCalls++
          return { kind: "allow", reason: "unexpected" }
        },
      },
    )
    const attempt = new ReviewAttempt("generation", 8_000)

    try {
      const result = await reviewer.review(envelope(), attempt, {} as OpenCodeClient)
      expect(requests, testCase.name).toBe(1)
      if (testCase.name === "deny") expect(result.kind, testCase.name).toBe("deny")
      else expect(result.kind, testCase.name).toBe("escalate")
      expect(reasoningCalls, testCase.name).toBe(testCase.name === "deny" ? 0 : 1)
    } finally {
      attempt.close("finished")
      await reviewer.waitForIdle()
    }
  }
})

test("mixed route failures apply the router category once and never invoke reasoning", async () => {
  const cases = [
    {
      onInvalidDecision: "deny" as const,
      onReviewerFailure: "manual" as const,
      expectedDisposition: "deny" as const,
    },
    {
      onInvalidDecision: "manual" as const,
      onReviewerFailure: "manual" as const,
      expectedDisposition: "manual" as const,
    },
    {
      onInvalidDecision: "manual" as const,
      onReviewerFailure: "deny" as const,
      expectedDisposition: "deny" as const,
    },
  ]

  for (const knobs of cases) {
    let calls = 0
    let reasoningCalls = 0
    const transport: DecisionsTransport = async (request) => {
      request.onRequestSent()
      calls++
      if (request.model === "opencode/jev-1.13-free") return { model: "wrong", answers: {} }
      throw new TypeError("network failure")
    }
    const reviewer = backend(
      config({
        decisionModels: ["opencode/jev-1.13-free", "openrouter/vendor/second"],
        riskPolicy: {
          ...config().riskPolicy,
          onInvalidDecision: knobs.onInvalidDecision,
          onReviewerFailure: knobs.onReviewerFailure,
        },
      }),
      transport,
      {
        model: "openrouter/vendor/reasoning",
        review: async () => {
          reasoningCalls++
          return { kind: "allow", reason: "must not run" }
        },
      },
    )
    const attempt = new ReviewAttempt("generation", 8_000)
    const review = envelope()

    try {
      const result = await reviewer.review(review, attempt, {} as OpenCodeClient)
      expect(result.kind).toBe(knobs.expectedDisposition === "deny" ? "deny" : "escalate")
      expect(result.escalationDisposition).toBe(knobs.expectedDisposition)
      expect(result.decisionAttempts?.map((item) => item.outcome)).toEqual([
        "invalid-decision",
        "network-error",
      ])
      expect(calls).toBe(2)
      expect(reasoningCalls).toBe(0)
    } finally {
      attempt.close("finished")
      await reviewer.waitForIdle()
    }
  }
})

test("reasoning failure retains selected Decisions attribution and every attempt", async () => {
  const transport: DecisionsTransport = async (request) => {
    request.onRequestSent()
    return systemOneResponse("jev-1.13-free", { basis: "destructive_effect" })
  }
  const reviewer = backend(config({ decisionModels: ["opencode/jev-1.13-free"] }), transport, {
    model: "openrouter/vendor/reasoning-first",
    review: async () => ({
      kind: "escalate",
      reason: "reasoning session failed",
      decisionSource: "failure-safe",
    }),
  })
  const attempt = new ReviewAttempt("generation", 8_000)
  const review = envelope()

  try {
    const result = await reviewer.review(review, attempt, {} as OpenCodeClient)
    expect(result.kind).toBe("escalate")
    expect(result.reviewerModel).toBe("opencode/jev-1.13-free")
    expect(result.responseModel).toBe("jev-1.13-free")
    expect(result.reviewerEscalatedFrom?.model).toBe("opencode/jev-1.13-free")
    expect(review.decisionTrace?.reviewerModel).toBe("opencode/jev-1.13-free")
    expect(review.decisionTrace?.reviewerEscalatedFrom).toBeUndefined()
    expect(result.decisionAttempts).toEqual(review.decisionTrace?.attempts)
    expect(result.decisionAttempts?.[0]?.outcome).toBe("valid-decision")
    expect(result.decisionAttempts?.[0]?.responseModel).toBe("jev-1.13-free")
  } finally {
    attempt.close("finished")
    await reviewer.waitForIdle()
  }
})

test("successful reasoning provenance survives a fresh gate-result replacement", async () => {
  const selectedModel = "opencode/jev-1.13-free"
  const reasoningModel = "openrouter/vendor/reasoning"
  const transport: DecisionsTransport = async (request) => {
    request.onRequestSent()
    return systemOneResponse("jev-1.13-free", { basis: "destructive_effect" })
  }
  const reviewer = backend(config({ decisionModels: [selectedModel] }), transport, {
    model: reasoningModel,
    review: async () => ({
      kind: "allow",
      decision: reviewerDecision("allow"),
      reason: "reasoning reviewer approved",
      decisionSource: "llm-reviewer",
      reviewerOutcome: "allow",
    }),
  })
  const attempt = new ReviewAttempt("generation", 8_000)
  const review = envelope()

  try {
    const result = await reviewer.review(review, attempt, {} as OpenCodeClient)
    expect(result.kind).toBe("allow")
    expect(result.reviewerModel).toBe(reasoningModel)
    expect(result.reviewerEscalatedFrom?.model).toBe(selectedModel)
    expect(result.responseModel).toBe("jev-1.13-free")

    const freshGateResult: ReviewExecutionResult = {
      kind: "escalate",
      reason: "trusted configuration is degraded",
      decisionSource: "failure-safe",
    }
    expect(freshGateResult.reviewerModel).toBeUndefined()
    expect(review.decisionTrace).toMatchObject({
      reviewerModel: reasoningModel,
      reviewerEscalatedFrom: { model: selectedModel },
      responseModel: "jev-1.13-free",
    })

    const projected = {
      ...freshGateResult,
      reviewerModel: review.decisionTrace?.reviewerModel,
      reviewerEscalatedFrom: review.decisionTrace?.reviewerEscalatedFrom,
      responseModel: review.decisionTrace?.responseModel,
    }
    expect(projected).toMatchObject({
      reviewerModel: reasoningModel,
      reviewerEscalatedFrom: { model: selectedModel },
      responseModel: "jev-1.13-free",
    })
  } finally {
    attempt.close("finished")
    await reviewer.waitForIdle()
  }
})

test("inconclusive reasoning keeps primary attribution and does not mark a successful reasoner", async () => {
  const selectedModel = "opencode/jev-1.13-free"
  const reasoningModel = "openrouter/vendor/reasoning"
  const transport: DecisionsTransport = async (request) => {
    request.onRequestSent()
    return systemOneResponse("jev-1.13-free", { basis: "destructive_effect" })
  }
  const reviewer = backend(config({ decisionModels: [selectedModel] }), transport, {
    model: reasoningModel,
    review: async () => ({
      kind: "escalate",
      decision: reviewerDecision("escalate"),
      reason: "reasoning remains inconclusive",
      decisionSource: "llm-reviewer",
      reviewerOutcome: "escalate",
    }),
  })
  const attempt = new ReviewAttempt("generation", 8_000)
  const review = envelope()

  try {
    const result = await reviewer.review(review, attempt, {} as OpenCodeClient)
    expect(result.kind).toBe("escalate")
    expect(result.reviewerOutcome).toBe("escalate")
    expect(result.reviewerModel).toBe(selectedModel)
    expect(review.decisionTrace?.reviewerModel).toBe(selectedModel)
    expect(review.decisionTrace?.reviewerEscalatedFrom).toBeUndefined()
  } finally {
    attempt.close("finished")
    await reviewer.waitForIdle()
  }
})

test("cancellation synchronously finalizes the envelope-owned in-flight trace", async () => {
  let started!: () => void
  const hasStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  const transport: DecisionsTransport = async (request) => {
    request.onRequestSent()
    started()
    return new Promise<unknown>(() => {})
  }
  const reviewer = backend(config({ decisionModels: ["opencode/jev-1.13-free"] }), transport)
  const attempt = new ReviewAttempt("generation", 8_000)
  const review = envelope()
  const pending = reviewer.review(review, attempt, {} as OpenCodeClient)

  try {
    await hasStarted
    attempt.close("cancelled")
    expect(review.decisionTrace?.attempts).toHaveLength(1)
    expect(review.decisionTrace?.attempts[0]).toMatchObject({
      outcome: "cancelled",
      requestSent: true,
    })
    const result = await pending
    expect(result.decisionAttempts).toEqual(review.decisionTrace?.attempts)
    expect(result.kind).toBe("escalate")
  } finally {
    attempt.close("finished")
    await reviewer.waitForIdle()
  }
})

test("canonical trace preserves internal transport failure and reviewer-failure disposition", async () => {
  const transport: DecisionsTransport = async () => {
    throw new DecisionsTransportError("internal")
  }
  const resolved = config({
    decisionModels: ["openrouter/vendor/model"],
    riskPolicy: {
      ...config().riskPolicy,
      onReviewerFailure: "deny",
    },
  })
  const reviewer = backend(resolved, transport)
  const attempt = new ReviewAttempt("generation", 8_000)
  const review = envelope()

  try {
    const result = await reviewer.review(review, attempt, {} as OpenCodeClient)
    expect(result.kind).toBe("deny")
    expect(result.escalationDisposition).toBe("deny")
    expect(result.decisionAttempts).toHaveLength(1)
    expect(result.decisionAttempts?.[0]).toMatchObject({
      outcome: "internal-error",
      requestSent: false,
    })
    expect(result.decisionAttempts?.[0]?.httpStatus).toBeUndefined()
    expect(review.decisionTrace?.attempts).toEqual(result.decisionAttempts)
  } finally {
    attempt.close("finished")
    await reviewer.waitForIdle()
  }
})

function attemptRecord(
  model: string,
  modelIndex: number,
  outcome: DecisionAttemptRecord["outcome"],
  extra: { responseModel?: string } = {},
): DecisionAttemptRecord {
  return {
    model,
    modelIndex,
    attempt: 1,
    requestSent: true,
    outcome,
    durationMs: 5,
    ...extra,
  }
}

test("live trace slices stay plain arrays and never leak derived pushes into the envelope", async () => {
  const reviewer = backend(config({ decisionModels: ["opencode/jev-1.13-free"] }), async () => {
    throw new Error("the injected route must not reach the transport")
  })
  const injectable = reviewer as unknown as {
    route: (
      state: unknown,
      attempt: ReviewAttempt,
      trace: DecisionsRouteTrace,
    ) => Promise<DecisionsSelection>
  }
  let live!: DecisionAttemptRecord[]
  injectable.route = async (_state, _attempt, trace) => {
    live = trace.attempts
    return { kind: "failed", category: "reviewer-failure", reason: "captured", attempts: [] }
  }
  const attempt = new ReviewAttempt("generation", 8_000)
  const review = envelope()

  try {
    await reviewer.review(review, attempt, {} as OpenCodeClient)
    expect(live).toBeDefined()

    live.push(
      attemptRecord("opencode/jev-1.13-free", 0, "selected", {
        responseModel: "jev-1.13-free",
      }),
    )
    live.push(attemptRecord("openrouter/vendor/second", 1, "network-error"))
    expect(review.decisionTrace?.attempts).toEqual([
      {
        model: "opencode/jev-1.13-free",
        modelIndex: 0,
        attempt: 1,
        requestSent: true,
        outcome: "valid-decision",
        durationMs: 5,
        responseModel: "jev-1.13-free",
      },
      {
        model: "openrouter/vendor/second",
        modelIndex: 1,
        attempt: 1,
        requestSent: true,
        outcome: "network-error",
        durationMs: 5,
      },
    ])

    const derived = live.slice(0, 40)
    expect(() =>
      derived.push(attemptRecord("openrouter/vendor/third", 2, "internal-error")),
    ).not.toThrow()
    expect(derived).toHaveLength(3)
    expect(Object.getPrototypeOf(derived)).toBe(Array.prototype)
    expect(Array.isArray(derived)).toBe(true)
    // The derived copy owns no destination: pushing to it must not touch the envelope trace.
    expect(review.decisionTrace?.attempts).toHaveLength(2)
    expect(live).toHaveLength(2)
  } finally {
    attempt.close("finished")
    await reviewer.waitForIdle()
  }
})
