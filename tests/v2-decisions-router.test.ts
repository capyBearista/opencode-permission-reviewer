import { describe, expect, test } from "bun:test"
import { resolveConfig } from "../src/config.ts"
import { ReviewAttempt } from "../src/core/review-attempt.ts"
import {
  createDecisionsRouteTrace,
  createDecisionsRouter,
} from "../src/system-one/decisions-router.ts"
import {
  createDecisionsTransport,
  DecisionsTransportError,
  type DecisionsTransport,
  type DecisionsTransportRequest,
} from "../src/system-one/decisions-transport.ts"
import { SYSTEM_ONE_QUESTIONS } from "../src/system-one/review.ts"
import type { ReviewerConfig } from "../src/types.ts"

const STATE = {
  trustedPolicy: { reviewer: "trusted policy", tenant: "tenant" },
  untrustedEvidence: "inspect the requested command",
}

function validResponse(model: string, outcome = "allow"): Record<string, unknown> {
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
        return [
          name,
          {
            type: "noul",
            noul: ["material_authorization", "within_intent_scope"].includes(name) ? 1 : 0,
          },
        ]
      }
      const criteria = Object.keys(question.criteria)
      const choice = picks[name] ?? criteria[0]!
      return [
        name,
        {
          type: "choice",
          choice,
          confidence: 1,
          probabilities: Object.fromEntries(criteria.map((key) => [key, key === choice ? 1 : 0])),
        },
      ]
    }),
  )
  return { model, answers }
}

function settings(
  models: string[],
  transport: DecisionsTransport,
  options: { attemptsPerModel?: number; timeoutMs?: number; config?: ReviewerConfig } = {},
) {
  return createDecisionsRouter({
    config: options.config ?? resolveConfig({ model: models[0] }),
    models,
    transport,
    ...(options.attemptsPerModel === undefined
      ? {}
      : { attemptsPerModel: options.attemptsPerModel }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  })
}

function send<T>(request: DecisionsTransportRequest, result: T): T {
  request.onRequestSent()
  return result
}

function failedResponseBody(status: number, error: Error): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(error)
      },
    }),
    { status },
  )
}

function http(status: number, message?: string) {
  return new DecisionsTransportError("http", {
    status,
    requestSent: true,
    ...(message === undefined ? {} : { providerMessage: message }),
  })
}

function withPolicies(invalid: "manual" | "deny", operational: "manual" | "deny") {
  const base = resolveConfig({ model: "openrouter/vendor/first" })
  return {
    ...base,
    riskPolicy: {
      ...base.riskPolicy,
      onInvalidDecision: invalid,
      onReviewerFailure: operational,
    },
  }
}

describe("ordered V2 Decisions selection", () => {
  test("retries invalid output on the same model, then selects the first valid later model", async () => {
    const seen: string[] = []
    const models = ["opencode/jev-1.13-free", "openrouter/vendor/model"]
    const transport: DecisionsTransport = async (request) => {
      seen.push(request.model)
      if (request.model === models[0]) return send(request, { model: "wrong", answers: {} })
      return send(request, validResponse("vendor/model", "deny"))
    }
    const attempt = new ReviewAttempt("g", 10_000)
    try {
      const selected = await settings(models, transport)(STATE, attempt)
      expect(selected.kind).toBe("selected")
      if (selected.kind !== "selected") return
      expect(seen).toEqual([models[0]!, models[0]!, models[1]!])
      expect(selected.model).toBe(models[1]!)
      expect(selected.parsed.decision.outcome).toBe("deny")
      expect(selected.attempts.map(({ outcome }) => outcome)).toEqual([
        "invalid-decision",
        "invalid-decision",
        "selected",
      ])
      expect(selected.attempts[2]).toMatchObject({
        model: models[1]!,
        modelIndex: 1,
        attempt: 1,
        requestSent: true,
        responseModel: "vendor/model",
      })
    } finally {
      attempt.close("finished")
    }
  })

  test("retries invalid JSON and honors the configured maximum of five attempts", async () => {
    let calls = 0
    const model = "openrouter/vendor/model"
    const router = settings(
      [model],
      async (request) => {
        if (++calls < 5) throw new DecisionsTransportError("invalid-json", { requestSent: true })
        return send(request, validResponse("vendor/model"))
      },
      { attemptsPerModel: 5 },
    )
    const attempt = new ReviewAttempt("g", 15_000)
    try {
      const result = await router(STATE, attempt)
      expect(result.kind).toBe("selected")
      expect(calls).toBe(5)
      expect(result.attempts.map(({ attempt }) => attempt)).toEqual([1, 2, 3, 4, 5])
    } finally {
      attempt.close("finished")
    }
  })

  test("returns a valid contradictory/escalate response immediately without enforcement", async () => {
    let calls = 0
    const models = ["openrouter/vendor/model"]
    const router = settings(models, async (request) => {
      calls++
      return send(request, validResponse("vendor/model", "escalate"))
    })
    const attempt = new ReviewAttempt("g", 10_000)
    try {
      const result = await router(STATE, attempt)
      expect(calls).toBe(1)
      expect(result.kind).toBe("selected")
      if (result.kind === "selected") expect(result.parsed.decision.outcome).toBe("escalate")
    } finally {
      attempt.close("finished")
    }
  })

  test("stops on allow, deny, escalate, low-confidence, and contradictory parser-valid results", async () => {
    const cases: Array<{
      outcome: "allow" | "deny" | "escalate"
      response: Record<string, unknown>
      difficult: boolean
    }> = [
      { outcome: "allow", response: validResponse("vendor/model", "allow"), difficult: false },
      { outcome: "deny", response: validResponse("vendor/model", "deny"), difficult: true },
      {
        outcome: "escalate",
        response: validResponse("vendor/model", "escalate"),
        difficult: true,
      },
    ]
    const lowConfidence = validResponse("vendor/model")
    const lowAnswers = lowConfidence.answers as Record<string, Record<string, unknown>>
    lowAnswers.outcome!.confidence = 0.35
    lowAnswers.outcome!.probabilities = { allow: 0.35, deny: 0.325, escalate: 0.325 }
    cases.push({ outcome: "allow", response: lowConfidence, difficult: true })

    const contradictory = validResponse("vendor/model")
    const contradictoryAnswers = contradictory.answers as Record<string, Record<string, unknown>>
    contradictoryAnswers.unauthorized_data_loss!.noul = 1
    cases.push({ outcome: "allow", response: contradictory, difficult: true })

    for (const item of cases) {
      let calls = 0
      const router = settings(["openrouter/vendor/model"], async (request) => {
        calls++
        return send(request, item.response)
      })
      const attempt = new ReviewAttempt("g", 10_000)
      try {
        const result = await router(STATE, attempt)
        expect(calls).toBe(1)
        expect(result.kind).toBe("selected")
        if (result.kind === "selected") {
          expect(result.parsed.decision.outcome).toBe(item.outcome)
          expect(result.parsed.difficultReason !== undefined).toBe(item.difficult)
        }
      } finally {
        attempt.close("finished")
      }
    }
  })

  test("skips model-specific 400, auth, and unavailable routes but still tries later same-provider models", async () => {
    const models = [
      "openrouter/vendor/missing",
      "openrouter/vendor/unauthorized",
      "openrouter/vendor/second",
    ]
    const seen: string[] = []
    const transport: DecisionsTransport = async (request) => {
      seen.push(request.model)
      if (request.model === models[0]) throw http(400, "Model vendor/missing does not exist")
      if (request.model === models[1]) throw http(401)
      return send(request, validResponse("vendor/second"))
    }
    const attempt = new ReviewAttempt("g", 10_000)
    try {
      const result = await settings(models, transport)(STATE, attempt)
      expect(result.kind).toBe("selected")
      expect(seen).toEqual(models)
      expect(result.attempts.map(({ outcome }) => outcome)).toEqual([
        "model-not-found",
        "access-unavailable",
        "selected",
      ])
    } finally {
      attempt.close("finished")
    }
  })

  test("missing credentials skip same-model retries but permit a later same-provider model", async () => {
    const models = ["openrouter/vendor/first", "openrouter/vendor/second"]
    const transport: DecisionsTransport = async (request) => {
      if (request.model === models[0]) throw new DecisionsTransportError("missing-credentials")
      return send(request, validResponse("vendor/second"))
    }
    const attempt = new ReviewAttempt("g", 10_000)
    try {
      const result = await settings(models, transport, { attemptsPerModel: 4 })(STATE, attempt)
      expect(result.kind).toBe("selected")
      expect(
        result.attempts.map((entry) => [entry.modelIndex, entry.attempt, entry.requestSent]),
      ).toEqual([
        [0, 1, false],
        [1, 1, true],
      ])
    } finally {
      attempt.close("finished")
    }
  })

  test("tries all configured later models after each auth and unavailable status", async () => {
    for (const status of [401, 402, 403, 404, 410]) {
      const models = ["openrouter/vendor/first", "openrouter/vendor/second"]
      const seen: string[] = []
      const transport: DecisionsTransport = async (request) => {
        seen.push(request.model)
        if (request.model === models[0]) throw http(status)
        return send(request, validResponse("vendor/second"))
      }
      const attempt = new ReviewAttempt("g", 10_000)
      try {
        const result = await settings(models, transport, { attemptsPerModel: 3 })(STATE, attempt)
        expect(result.kind).toBe("selected")
        expect(seen).toEqual(models)
      } finally {
        attempt.close("finished")
      }
    }
  })

  test("uses HTTP status when an optional error body stream fails", async () => {
    for (const error of [new TypeError("stream failed"), new Error("stream failed")]) {
      for (const status of [400, 401, 503]) {
        const models = ["openrouter/vendor/first", "openrouter/vendor/second"]
        const requests: string[] = []
        const transport = createDecisionsTransport({
          resolveOpenRouterKey: async () => "synthetic-key",
          fetchImpl: async (_url, init) => {
            const model = JSON.parse(String(init?.body)).model as string
            requests.push(model)
            if (model === "vendor/first" && requests.length === 1)
              return failedResponseBody(status, error)
            return Response.json(validResponse(model))
          },
        })
        const attempt = new ReviewAttempt("g", 10_000)
        try {
          const result = await settings(models, transport, { attemptsPerModel: 2 })(STATE, attempt)
          if (status === 400) {
            expect(result.kind).toBe("failed")
            expect(requests).toEqual(["vendor/first"])
            expect(result.attempts[0]).toMatchObject({
              requestSent: true,
              outcome: "invalid-request",
              httpStatus: 400,
            })
          } else if (status === 401) {
            expect(result.kind).toBe("selected")
            expect(requests).toEqual(["vendor/first", "vendor/second"])
            expect(result.attempts[0]).toMatchObject({
              requestSent: true,
              outcome: "access-unavailable",
              httpStatus: 401,
            })
          } else {
            expect(result.kind).toBe("selected")
            expect(requests).toEqual(["vendor/first", "vendor/first"])
            expect(result.attempts[0]).toMatchObject({
              requestSent: true,
              outcome: "http-retryable",
              httpStatus: 503,
            })
          }
        } finally {
          attempt.close("finished")
        }
      }
    }
  })

  test("a global invalid 400 with an embedded missing-model literal stops routing", async () => {
    const models = ["openrouter/vendor/first", "openrouter/vendor/second"]
    const requested: string[] = []
    const transport = createDecisionsTransport({
      resolveOpenRouterKey: async () => "synthetic-key",
      fetchImpl: async (_url, init) => {
        const model = JSON.parse(String(init?.body)).model as string
        requested.push(model)
        return Response.json(
          {
            error: {
              message:
                "Invalid state contains literal Model vendor/first does not exist; fix the global request.",
            },
          },
          { status: 400 },
        )
      },
    })
    const attempt = new ReviewAttempt("g", 10_000)
    try {
      const result = await settings(models, transport, { attemptsPerModel: 3 })(STATE, attempt)
      expect(result.kind).toBe("failed")
      expect(requested).toEqual(["vendor/first"])
      if (result.kind === "failed") {
        expect(result.category).toBe("reviewer-failure")
        expect(result.attempts).toHaveLength(1)
        expect(result.attempts[0]).toMatchObject({
          requestSent: true,
          outcome: "invalid-request",
          httpStatus: 400,
        })
      }
    } finally {
      attempt.close("finished")
    }
  })

  test("a padded-tail 400 stays globally terminal instead of advancing the route", async () => {
    const paddedTail = `Model vendor/first does not exist${" ".repeat(1100)}; invalid global request`
    const models = ["openrouter/vendor/first", "openrouter/vendor/second"]
    const requested: string[] = []
    const transport = createDecisionsTransport({
      resolveOpenRouterKey: async () => "synthetic-key",
      fetchImpl: async (_url, init) => {
        const model = JSON.parse(String(init?.body)).model as string
        requested.push(model)
        return Response.json({ error: { message: paddedTail } }, { status: 400 })
      },
    })
    const attempt = new ReviewAttempt("g", 10_000)
    try {
      const result = await settings(models, transport, { attemptsPerModel: 3 })(STATE, attempt)
      expect(result.kind).toBe("failed")
      expect(requested).toEqual(["vendor/first"])
      if (result.kind === "failed") {
        expect(result.category).toBe("reviewer-failure")
        expect(result.attempts).toHaveLength(1)
        expect(result.attempts[0]).toMatchObject({
          requestSent: true,
          outcome: "invalid-request",
          httpStatus: 400,
        })
      }
    } finally {
      attempt.close("finished")
    }
  })

  test("an exact missing-model 400 advances to the next configured model", async () => {
    const models = ["openrouter/vendor/first", "openrouter/vendor/second"]
    const requested: string[] = []
    const transport = createDecisionsTransport({
      resolveOpenRouterKey: async () => "synthetic-key",
      fetchImpl: async (_url, init) => {
        const model = JSON.parse(String(init?.body)).model as string
        requested.push(model)
        if (model === "vendor/first")
          return Response.json(
            { error: { message: "Model vendor/first does not exist" } },
            { status: 400 },
          )
        return Response.json(validResponse(model))
      },
    })
    const attempt = new ReviewAttempt("g", 10_000)
    try {
      const result = await settings(models, transport, { attemptsPerModel: 3 })(STATE, attempt)
      expect(result.kind).toBe("selected")
      expect(requested).toEqual(["vendor/first", "vendor/second"])
      expect(result.attempts[0]).toMatchObject({
        requestSent: true,
        outcome: "model-not-found",
        httpStatus: 400,
      })
    } finally {
      attempt.close("finished")
    }
  })

  test("retries each transient HTTP class on the same model before selecting", async () => {
    for (const status of [408, 429, 500]) {
      let calls = 0
      const models = ["openrouter/vendor/model"]
      const transport: DecisionsTransport = async (request) => {
        if (++calls === 1) throw http(status)
        return send(request, validResponse("vendor/model"))
      }
      const attempt = new ReviewAttempt("g", 10_000)
      try {
        const result = await settings(models, transport, { attemptsPerModel: 2 })(STATE, attempt)
        expect(result.kind).toBe("selected")
        expect(calls).toBe(2)
        expect(result.attempts[0]).toMatchObject({ outcome: "http-retryable", httpStatus: status })
      } finally {
        attempt.close("finished")
      }
    }
  })

  test("terminates on generic 400, 413, 422, and unexpected statuses", async () => {
    for (const status of [400, 413, 422, 418]) {
      let calls = 0
      const models = ["openrouter/vendor/first", "openrouter/vendor/second"]
      const router = settings(models, async () => {
        calls++
        throw http(status, status === 400 ? "Invalid request" : undefined)
      })
      const attempt = new ReviewAttempt("g", 10_000)
      try {
        const result = await router(STATE, attempt)
        expect(result.kind).toBe("failed")
        if (result.kind === "failed") {
          expect(result.category).toBe("reviewer-failure")
          expect(result.attempts).toHaveLength(1)
          expect(result.reason).not.toContain("Invalid request")
        }
        expect(calls).toBe(1)
      } finally {
        attempt.close("finished")
      }
    }
  })

  test("treats an oversized HTTP 400 as global invalid request, not model-not-found", async () => {
    let calls = 0
    const models = ["openrouter/vendor/model", "openrouter/vendor/second"]
    const router = settings(models, async () => {
      calls++
      throw new DecisionsTransportError("response-too-large", {
        status: 400,
        requestSent: true,
      })
    })
    const attempt = new ReviewAttempt("g", 10_000)
    try {
      const result = await router(STATE, attempt)
      expect(result.kind).toBe("failed")
      expect(result.attempts[0]).toMatchObject({ outcome: "invalid-request", httpStatus: 400 })
      expect(calls).toBe(1)
    } finally {
      attempt.close("finished")
    }
  })

  test("mixed structural and operational exhaustion honors both restrictive knob directions", async () => {
    for (const [invalid, operational, expected] of [
      ["deny", "manual", "invalid-decision"],
      ["manual", "deny", "reviewer-failure"],
      ["manual", "manual", "reviewer-failure"],
    ] as const) {
      const models = ["openrouter/vendor/first", "openrouter/vendor/second"]
      const transport: DecisionsTransport = async (request) => {
        if (request.model === models[0]) return send(request, { model: "wrong", answers: {} })
        request.onRequestSent()
        throw new TypeError("synthetic network failure with private detail")
      }
      const attempt = new ReviewAttempt("g", 10_000)
      try {
        const result = await settings(models, transport, {
          attemptsPerModel: 1,
          config: withPolicies(invalid, operational),
        })(STATE, attempt)
        expect(result.kind).toBe("failed")
        if (result.kind === "failed") {
          expect(result.category).toBe(expected)
          expect(result.reason).not.toContain("private detail")
          expect(result.attempts.map(({ outcome }) => outcome)).toEqual([
            "invalid-decision",
            "network-error",
          ])
        }
      } finally {
        attempt.close("finished")
      }
    }
  })

  test("tracks invalid JSON and oversized success as structural failures in either order", async () => {
    for (const structural of ["invalid-json", "oversized-success"] as const) {
      for (const order of ["structural-first", "network-first"] as const) {
        for (const [invalid, operational, expected] of [
          ["deny", "manual", "invalid-decision"],
          ["manual", "deny", "reviewer-failure"],
        ] as const) {
          const models = ["openrouter/vendor/first", "openrouter/vendor/second"]
          const structuralError =
            structural === "invalid-json"
              ? new DecisionsTransportError("invalid-json", { requestSent: true })
              : new DecisionsTransportError("response-too-large", {
                  requestSent: true,
                  status: 200,
                })
          const failures =
            order === "structural-first"
              ? [structuralError, new TypeError("synthetic network failure")]
              : [new TypeError("synthetic network failure"), structuralError]
          let calls = 0
          const transport: DecisionsTransport = async (request) => {
            request.onRequestSent()
            throw failures[calls++]
          }
          const attempt = new ReviewAttempt("g", 10_000)
          try {
            const result = await settings(models, transport, {
              attemptsPerModel: 1,
              config: withPolicies(invalid, operational),
            })(STATE, attempt)
            expect(result.kind).toBe("failed")
            if (result.kind === "failed") {
              expect(result.category).toBe(expected)
              expect(result.attempts.map(({ outcome }) => outcome)).toEqual(
                order === "structural-first"
                  ? ["invalid-decision", "network-error"]
                  : ["network-error", "invalid-decision"],
              )
            }
          } finally {
            attempt.close("finished")
          }
        }
      }
    }
  })

  test("does not retry or disclose transport detail for pure failure categories", async () => {
    for (const [failure, expected] of [
      ["structural", "invalid-decision"],
      ["network", "reviewer-failure"],
    ] as const) {
      const models = ["openrouter/vendor/model"]
      const transport: DecisionsTransport = async (request) => {
        if (failure === "structural") return send(request, { model: "wrong", answers: {} })
        request.onRequestSent()
        throw new TypeError("secret-bearing transport detail")
      }
      const attempt = new ReviewAttempt("g", 10_000)
      try {
        const result = await settings(models, transport, { attemptsPerModel: 1 })(STATE, attempt)
        expect(result.kind).toBe("failed")
        if (result.kind === "failed") {
          expect(result.category).toBe(expected)
          expect(result.reason).not.toContain("secret-bearing")
        }
      } finally {
        attempt.close("finished")
      }
    }
  })

  test("stops synchronously on cancellation, finalizes trace, and ignores late completion", async () => {
    let complete!: (result: unknown) => void
    let sent = false
    const late = new Promise<unknown>((resolve) => {
      complete = resolve
    })
    let calls = 0
    const models = ["openrouter/vendor/first", "openrouter/vendor/second"]
    const trace = createDecisionsRouteTrace()
    const router = settings(models, async (request) => {
      calls++
      request.onRequestSent()
      sent = true
      return late
    })
    const attempt = new ReviewAttempt("g", 10_000)
    const pending = router(STATE, attempt, trace)
    while (!sent) await Promise.resolve()
    attempt.close("cancelled")

    expect(trace.attempts).toHaveLength(1)
    expect(trace.attempts[0]).toMatchObject({ outcome: "cancelled", requestSent: true })
    const result = await pending
    expect(result.kind).toBe("failed")
    complete(validResponse("vendor/first"))
    await Promise.resolve()
    expect(calls).toBe(1)
    expect(trace.attempts).toHaveLength(1)
  })

  test("classifies cancellation as reviewer failure instead of applying exhaustion precedence", async () => {
    let finishSecond!: (value: unknown) => void
    let secondStarted!: () => void
    const started = new Promise<void>((resolve) => {
      secondStarted = resolve
    })
    const second = new Promise<unknown>((resolve) => {
      finishSecond = resolve
    })
    const models = ["openrouter/vendor/first", "openrouter/vendor/second"]
    const config = withPolicies("deny", "manual")
    const router = settings(
      models,
      async (request) => {
        if (request.model === models[0]) return send(request, { model: "wrong", answers: {} })
        request.onRequestSent()
        secondStarted()
        return second
      },
      { attemptsPerModel: 1, config },
    )
    const attempt = new ReviewAttempt("g", 10_000)
    const pending = router(STATE, attempt)
    await started
    attempt.close("cancelled")
    const result = await pending
    finishSecond(validResponse("vendor/second"))

    expect(result.kind).toBe("failed")
    if (result.kind === "failed") expect(result.category).toBe("reviewer-failure")
  })

  test("cancels a retry backoff without starting another request", async () => {
    let firstCall!: () => void
    const called = new Promise<void>((resolve) => {
      firstCall = resolve
    })
    let calls = 0
    const router = settings(["openrouter/vendor/model"], async (request) => {
      calls++
      request.onRequestSent()
      firstCall()
      throw new TypeError("transient network error")
    })
    const attempt = new ReviewAttempt("g", 10_000)
    const pending = router(STATE, attempt)
    await called
    await new Promise((resolve) => setTimeout(resolve, 0))
    attempt.close("cancelled")

    const result = await pending
    expect(result.kind).toBe("failed")
    expect(calls).toBe(1)
    expect(result.attempts).toHaveLength(1)
  })

  test("shared deadline stops an in-flight transport and records deadline finalization", async () => {
    let sent = false
    let calls = 0
    const trace = createDecisionsRouteTrace()
    const models = ["openrouter/vendor/first", "openrouter/vendor/second"]
    const router = settings(models, async (request) => {
      calls++
      request.onRequestSent()
      sent = true
      return new Promise<unknown>(() => {})
    })
    const attempt = new ReviewAttempt("g", 10)
    const result = await router(STATE, attempt, trace)

    expect(sent).toBe(true)
    expect(result.kind).toBe("failed")
    expect(trace.attempts).toHaveLength(1)
    expect(trace.attempts[0]).toMatchObject({ outcome: "deadline-exceeded", requestSent: true })
    expect(calls).toBe(1)
  })

  test("caps routing to eight configured models and keeps sanitized trace entries bounded", async () => {
    const models = Array.from({ length: 9 }, (_, index) => `openrouter/vendor/model-${index}`)
    const router = settings(
      models,
      async () => {
        throw new DecisionsTransportError("missing-credentials")
      },
      { attemptsPerModel: 5 },
    )
    const attempt = new ReviewAttempt("g", 10_000)
    try {
      const result = await router(STATE, attempt, createDecisionsRouteTrace())
      expect(result.kind).toBe("failed")
      expect(result.attempts).toHaveLength(8)
      expect(result.attempts.map(({ modelIndex }) => modelIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
      expect(
        result.attempts.every((record) =>
          Object.keys(record).every((key) =>
            [
              "model",
              "modelIndex",
              "attempt",
              "requestSent",
              "outcome",
              "httpStatus",
              "durationMs",
              "responseModel",
            ].includes(key),
          ),
        ),
      ).toBe(true)
      expect(result.attempts.some((record) => record.responseModel !== undefined)).toBe(false)
    } finally {
      attempt.close("finished")
    }
  })
})
