import { expect, test } from "bun:test"
import { pathToFileURL } from "node:url"
import type { OpenCodeClient } from "@opencode/client"
import type { Plugin } from "@opencode/plugin"
import { resolveConfig } from "../src/config.ts"
import { ReviewAttempt } from "../src/core/review-attempt.ts"
import { createV2ReviewerBackend } from "../src/opencode/v2/backend-factory.ts"
import { SYSTEM_ONE_QUESTIONS } from "../src/system-one/review.ts"
import type { ReviewEnvelope, ReviewExecutionResult } from "../src/types.ts"
import { decision as reviewerDecision } from "./helpers.ts"

function decision(model: string, basis = "authorized_routine") {
  const selected: Record<string, string> = {
    outcome: "allow",
    risk_level: "low",
    user_authorization: "high",
    scope_alignment: "aligned",
    evidence_completeness: "sufficient",
    primary_basis: basis,
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
            confidence: 1,
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
    request: {
      id: "request",
      sessionID: "session",
      permission: "bash",
      patterns: ["printf ok"],
      metadata: { command: "printf ok" },
      always: [],
    },
    directory: "/workspace",
    worktree: "/workspace",
    transcript: "User authorized printf ok",
    intentHistory: "User authorized printf ok",
    enrichment: "",
    sshAudit: [],
  }
}

function context(connection: {
  active: (id: string) => Promise<unknown>
  resolve?: (value: unknown) => Promise<unknown>
}) {
  return {
    integration: { connection },
  } as unknown as Parameters<Plugin.Plugin["setup"]>[0]
}

test("V2 factory always uses the native anonymous Zen Decisions route", async () => {
  const original = globalThis.fetch
  let connectionLookups = 0
  const requests: Array<{ url: string; init: RequestInit | undefined }> = []
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init })
    return Response.json(decision("jev-1.13-free"))
  }) as unknown as typeof fetch
  const attempt = new ReviewAttempt("generation", 8000)
  const review = envelope()
  let backend: ReturnType<typeof createV2ReviewerBackend> | undefined

  try {
    backend = createV2ReviewerBackend(
      context({
        active: async () => {
          connectionLookups++
          return undefined
        },
      }),
      resolveConfig(
        {
          model: "openrouter/ignored/legacy",
          systemOneFallback: { model: "openrouter/typesafe/jev-1.13" },
        },
        "v2",
      ),
    )
    const result = await backend.review(review, attempt, {} as OpenCodeClient)
    expect(result.kind, result.reason).toBe("allow")
    expect(result.reviewerModel).toBe("opencode/jev-1.13-free")
    expect(result.responseModel).toBe("jev-1.13-free")
    expect(result.decisionAttempts?.map((item) => item.outcome)).toEqual(["valid-decision"])
    expect(review.decisionTrace?.reviewerModel).toBe("opencode/jev-1.13-free")
    expect(review.decisionTrace?.responseModel).toBe("jev-1.13-free")
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe("https://opencode.ai/zen/v1/systemone")
    expect(new Headers(requests[0]?.init?.headers).has("authorization")).toBe(false)
    expect(JSON.parse(String(requests[0]?.init?.body)).model).toBe("jev-1.13-free")
    expect(connectionLookups).toBe(0)
  } finally {
    attempt.close("finished")
    globalThis.fetch = original
    await backend?.dispose()
  }
})

test("V2 factory resolves a saved OpenRouter key lazily and rejects OAuth without resolving it", async () => {
  const original = globalThis.fetch
  let opens = 0
  let resolves = 0
  const requests: Array<{ url: string; init: RequestInit | undefined }> = []
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init })
    return Response.json(decision("vendor/model"))
  }) as unknown as typeof fetch
  const attempt = new ReviewAttempt("generation", 8000)
  let backend: ReturnType<typeof createV2ReviewerBackend> | undefined

  try {
    backend = createV2ReviewerBackend(
      context({
        active: async (id) => {
          expect(id).toBe("openrouter")
          opens++
          return { type: "credential", method: "key", id: "saved" }
        },
        resolve: async () => {
          resolves++
          return { type: "key", key: "synthetic-saved-key" }
        },
      }),
      resolveConfig({ decisionModels: ["openrouter/vendor/model"] }, "v2"),
    )
    const result = await backend.review(envelope(), attempt, {} as OpenCodeClient)
    expect(result.kind, result.reason).toBe("allow")
    expect(opens).toBe(1)
    expect(resolves).toBe(1)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe("https://openrouter.ai/api/alpha/decisions")
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe(
      "Bearer synthetic-saved-key",
    )
    expect(JSON.parse(String(requests[0]?.init?.body)).model).toBe("vendor/model")
    expect(String(requests[0]?.init?.body)).not.toContain("synthetic-saved-key")
  } finally {
    attempt.close("finished")
    globalThis.fetch = original
    await backend?.dispose()
  }

  opens = 0
  resolves = 0
  requests.length = 0
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init })
    return Response.json(decision("vendor/model"))
  }) as unknown as typeof fetch
  const oauthAttempt = new ReviewAttempt("generation", 8000)
  let oauthBackend: ReturnType<typeof createV2ReviewerBackend> | undefined
  try {
    oauthBackend = createV2ReviewerBackend(
      context({
        active: async () => {
          opens++
          return { type: "credential", method: "oauth", id: "oauth" }
        },
        resolve: async () => {
          resolves++
          return { type: "oauth", access: "must-not-resolve" }
        },
      }),
      resolveConfig({ decisionModels: ["openrouter/vendor/model"] }, "v2"),
    )
    const result = await oauthBackend.review(envelope(), oauthAttempt, {} as OpenCodeClient)
    expect(result.kind).toBe("escalate")
    expect(result.decisionAttempts?.[0]).toMatchObject({
      outcome: "missing-credentials",
      requestSent: false,
    })
    expect(opens).toBe(1)
    expect(resolves).toBe(0)
    expect(requests).toHaveLength(0)
  } finally {
    oauthAttempt.close("finished")
    globalThis.fetch = original
    await oauthBackend?.dispose()
  }
})

test("late active OpenRouter connections after cancellation or attempt timeout never resolve or fetch", async () => {
  const violations: string[] = []
  for (const terminal of ["cancelled", "attempt-timeout"] as const) {
    const originalFetch = globalThis.fetch
    let fetches = 0
    let resolves = 0
    let releaseActive: ((value: unknown) => void) | undefined
    let markActiveStarted!: () => void
    const activeStarted = new Promise<void>((resolve) => {
      markActiveStarted = resolve
    })
    const activeConnection = new Promise<unknown>((resolve) => {
      releaseActive = resolve
    })
    globalThis.fetch = (async () => {
      fetches++
      return Response.json(decision("vendor/model"))
    }) as unknown as typeof fetch
    const attempt = new ReviewAttempt("generation", 6000)
    let backend: ReturnType<typeof createV2ReviewerBackend> | undefined
    let reviewPromise: Promise<ReviewExecutionResult> | undefined

    try {
      backend = createV2ReviewerBackend(
        context({
          active: async () => {
            markActiveStarted()
            return activeConnection
          },
          resolve: async () => {
            resolves++
            return { type: "key", key: "synthetic-saved-key" }
          },
        }),
        resolveConfig(
          {
            decisionModels: ["openrouter/vendor/model"],
            decisionMaxAttempts: 1,
            decisionAttemptTimeoutMs: 1000,
          },
          "v2",
        ),
      )
      reviewPromise = backend.review(envelope(), attempt, {} as OpenCodeClient)
      const state = await Promise.race([
        activeStarted.then(() => "active-started" as const),
        reviewPromise.then(() => "review-finished" as const),
      ])
      expect(state, terminal).toBe("active-started")

      if (terminal === "cancelled") attempt.close("cancelled")
      const result = await reviewPromise
      if (terminal === "attempt-timeout") expect(result.kind, terminal).toBe("escalate")

      releaseActive?.({ type: "credential", method: "key", id: "saved" })
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      if (resolves !== 0) violations.push(`${terminal}: resolved ${resolves} credential(s)`)
      if (fetches !== 0) violations.push(`${terminal}: sent ${fetches} request(s)`)
    } finally {
      attempt.close("finished")
      releaseActive?.({ type: "credential", method: "key", id: "saved" })
      globalThis.fetch = originalFetch
      await reviewPromise?.catch(() => undefined)
      await backend?.dispose()
    }
  }
  expect(violations).toEqual([])
})

test("an OpenRouter key resolving after cancellation is never used for fetch", async () => {
  const originalFetch = globalThis.fetch
  let fetches = 0
  let releaseCredential: ((value: unknown) => void) | undefined
  let markResolveStarted!: () => void
  const resolveStarted = new Promise<void>((resolve) => {
    markResolveStarted = resolve
  })
  const pendingCredential = new Promise<unknown>((resolve) => {
    releaseCredential = resolve
  })
  globalThis.fetch = (async () => {
    fetches++
    return Response.json(decision("vendor/model"))
  }) as unknown as typeof fetch
  const attempt = new ReviewAttempt("generation", 6000)
  let backend: ReturnType<typeof createV2ReviewerBackend> | undefined
  let reviewPromise: Promise<ReviewExecutionResult> | undefined

  try {
    backend = createV2ReviewerBackend(
      context({
        active: async () => ({ type: "credential", method: "key", id: "saved" }),
        resolve: async () => {
          markResolveStarted()
          return pendingCredential
        },
      }),
      resolveConfig(
        {
          decisionModels: ["openrouter/vendor/model"],
          decisionMaxAttempts: 1,
          decisionAttemptTimeoutMs: 1000,
        },
        "v2",
      ),
    )
    reviewPromise = backend.review(envelope(), attempt, {} as OpenCodeClient)
    const state = await Promise.race([
      resolveStarted.then(() => "resolve-started" as const),
      reviewPromise.then(() => "review-finished" as const),
    ])
    expect(state).toBe("resolve-started")

    attempt.close("cancelled")
    await reviewPromise
    releaseCredential?.({ type: "key", key: "synthetic-saved-key" })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(fetches).toBe(0)
  } finally {
    attempt.close("finished")
    releaseCredential?.({ type: "key", key: "synthetic-saved-key" })
    globalThis.fetch = originalFetch
    await reviewPromise?.catch(() => undefined)
    await backend?.dispose()
  }
})

test("an empty trusted V2 Decisions list does not fall through to defaults or paid reasoning", async () => {
  const original = globalThis.fetch
  let requests = 0
  let connectionLookups = 0
  globalThis.fetch = (async () => {
    requests++
    return Response.json(decision("jev-1.13-free"))
  }) as unknown as typeof fetch
  const attempt = new ReviewAttempt("generation", 8000)
  const review = envelope()
  let backend: ReturnType<typeof createV2ReviewerBackend> | undefined

  try {
    backend = createV2ReviewerBackend(
      context({
        active: async () => {
          connectionLookups++
          return undefined
        },
      }),
      resolveConfig(
        {
          decisionModels: [],
          reasoningModels: [
            {
              model: "openrouter/vendor/reasoning",
              variant: "fast",
              outputFormat: "text",
              timeoutMs: 30_000,
            },
          ],
        },
        "v2",
      ),
    )
    const result = await backend.review(review, attempt, {} as OpenCodeClient)
    expect(result.kind).toBe("escalate")
    expect(result.decisionSource).toBe("failure-safe")
    expect(result.decisionAttempts).toEqual([])
    expect(review.decisionTrace?.attempts).toEqual([])
    expect(requests).toBe(0)
    expect(connectionLookups).toBe(0)
  } finally {
    attempt.close("finished")
    globalThis.fetch = original
    await backend?.dispose()
  }
})

test("factory uses only reasoningModels[0] and preserves its text format, variant, timeout, and cleanup", async () => {
  const originalFetch = globalThis.fetch
  const originalTimeout = AbortSignal.timeout
  const timeouts: number[] = []
  const response = decision("jev-1.13-free", "destructive_effect")
  globalThis.fetch = (async () => Response.json(response)) as unknown as typeof fetch
  AbortSignal.timeout = ((milliseconds: number) => {
    timeouts.push(milliseconds)
    return originalTimeout.call(AbortSignal, milliseconds)
  }) as typeof AbortSignal.timeout

  let toolDefinition: {
    input: { parse(value: unknown): unknown }
    execute(value: unknown, event: { sessionID: string }): Promise<unknown>
  }
  let contextHook!: (event: {
    sessionID: string
    system: unknown[]
    messages: unknown[]
    tools: Record<string, unknown>
  }) => void
  let directory = ""
  let pluginID = ""
  let activated = false
  let removed = false
  let createdModel: unknown
  let createdPermissions: unknown
  let disposed = 0
  const reasoningPrompts: string[] = []
  const registration = () => ({ dispose: async () => void disposed++ })
  const isolatedContext = {
    location: { directory: "/workspace/operational" },
    mcp: {
      transform: async (callback: (editor: { list(): []; remove(): void }) => void) => {
        callback({ list: () => [], remove: () => {} })
        return registration()
      },
    },
    tool: {
      transform: async (
        callback: (editor: { add(value: typeof toolDefinition): void }) => void,
      ) => {
        callback({ add: (value) => (toolDefinition = value) })
        return registration()
      },
      hook: async () => registration(),
    },
    session: {
      hook: async (_name: string, callback: typeof contextHook) => {
        contextHook = callback
        return registration()
      },
    },
  } as unknown as Parameters<Plugin.Plugin["setup"]>[0]
  const client = {
    plugin: {
      list: async (input: { location: { directory: string } }) => {
        directory = input.location.directory
        if (!activated) {
          const plugin = await import(pathToFileURL(`${directory}/index.js`).href)
          pluginID = plugin.default.id
          await plugin.default.setup({ ...isolatedContext, location: { directory } })
          activated = true
        }
        return {
          data: [
            {
              id: pluginID,
              source: { type: "local", path: `${directory}/index.js` },
              state: { status: "active" },
            },
          ],
        }
      },
    },
    mcp: {
      list: async (input: { location: { directory: string } }) => ({
        location: input.location,
        data: [],
      }),
    },
    model: {
      list: async () => ({
        data: [
          {
            providerID: "openrouter",
            id: "vendor/reason-first",
            capabilities: { tools: true },
            variants: [{ id: "first-variant" }],
          },
        ],
      }),
    },
    session: {
      create: async (input: {
        id: string
        location: { directory: string }
        model: unknown
        permissions: unknown
      }) => {
        createdModel = input.model
        createdPermissions = input.permissions
        return { id: input.id, location: input.location }
      },
      prompt: async ({ sessionID, text }: { sessionID: string; text: string }) => {
        reasoningPrompts.push(text)
        const event = {
          sessionID,
          system: ["untrusted"],
          messages: ["untrusted"],
          tools: { permission_reviewer_result: toolDefinition, shell: {} },
        }
        contextHook(event)
        expect(JSON.stringify(event.system)).not.toContain("permission_reviewer_result")
        expect(Object.keys(event.tools)).toEqual([])
        return { id: `inbox_reasoning_${reasoningPrompts.length}` }
      },
      wait: async () => {},
      context: async () => {
        const first = reasoningPrompts.length === 1
        return [
          {
            type: "user",
            id: `inbox_reasoning_${reasoningPrompts.length}`,
            text: "evidence",
          },
          {
            type: "assistant",
            id: "reasoning_answer",
            content: [
              {
                type: "text",
                text: first ? "not a decision" : JSON.stringify(reviewerDecision("allow")),
              },
            ],
          },
        ]
      },
      interrupt: async () => {},
      remove: async () => {
        removed = true
      },
      get: async () => {
        if (removed) throw { _tag: "SessionNotFoundError" }
        return { id: "reasoning" }
      },
    },
  } as unknown as OpenCodeClient
  const attempt = new ReviewAttempt("generation", 8_000)
  const review = envelope()
  let backend: ReturnType<typeof createV2ReviewerBackend> | undefined

  try {
    backend = createV2ReviewerBackend(
      context({ active: async () => undefined }),
      resolveConfig(
        {
          reasoningModels: [
            {
              model: "openrouter/vendor/reason-first",
              variant: "first-variant",
              outputFormat: "text",
              timeoutMs: 47_000,
            },
            {
              model: "openrouter/vendor/reason-second",
              variant: "second-variant",
              outputFormat: "json_schema",
              timeoutMs: 60_000,
            },
          ],
        },
        "v2",
      ),
    )
    const result = await backend.review(review, attempt, client)
    expect(result.kind).toBe("allow")
    expect(result.reviewerModel).toBe("openrouter/vendor/reason-first")
    expect(result.responseModel).toBe("jev-1.13-free")
    expect(result.reviewerEscalatedFrom?.model).toBe("opencode/jev-1.13-free")
    expect(review.decisionTrace?.reviewerModel).toBe("openrouter/vendor/reason-first")
    expect(review.decisionTrace?.reviewerEscalatedFrom?.model).toBe("opencode/jev-1.13-free")
    expect(review.decisionTrace?.responseModel).toBe("jev-1.13-free")
    expect(createdModel).toEqual({
      id: "vendor/reason-first",
      providerID: "openrouter",
      variant: "first-variant",
    })
    expect(createdPermissions).toEqual([{ action: "*", resource: "*", effect: "deny" }])
    expect(timeouts).toContain(47_000)
    expect(timeouts).not.toContain(60_000)
    expect(reasoningPrompts).toHaveLength(2)
    expect(reasoningPrompts[1]).toContain("The prior response was invalid")
    expect(removed).toBe(true)
    await backend.dispose()
    expect(disposed).toBe(3)
  } finally {
    attempt.close("finished")
    globalThis.fetch = originalFetch
    AbortSignal.timeout = originalTimeout
    await backend?.dispose()
  }
})
