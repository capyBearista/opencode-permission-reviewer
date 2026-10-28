import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client"
import { setupWithServices } from "../src/opencode/v2/server.ts"
import type { V2ReviewBackend } from "../src/opencode/v2/backend-factory.ts"
import { normalizeV2Permission } from "../src/opencode/v2/permission-codec.ts"
import { resolveConfig } from "../src/config.ts"
import { DecisionsReviewerBackend } from "../src/system-one/decisions-backend.ts"
import { SYSTEM_ONE_QUESTIONS } from "../src/system-one/review.ts"
import type {
  DecisionRoutingTrace,
  PolicyRule,
  ReviewExecutionResult,
  ReviewerConfig,
} from "../src/types.ts"
import { config, decision } from "./helpers.ts"

type Input = Parameters<typeof normalizeV2Permission>[0] & { message?: string }

function systemOneResponse(model: string) {
  const selected: Record<string, string> = {
    outcome: "allow",
    risk_level: "low",
    user_authorization: "high",
    scope_alignment: "aligned",
    evidence_completeness: "sufficient",
    primary_basis: "destructive_effect",
  }
  return {
    model,
    usage: { input_tokens: 20, output_tokens: 0 },
    answers: Object.fromEntries(
      Object.entries(SYSTEM_ONE_QUESTIONS).map(([name, question]) => {
        if (question.type === "noul")
          return [
            name,
            {
              type: "noul",
              noul: ["material_authorization", "within_intent_scope"].includes(name) ? 1 : 0,
            },
          ]
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

function decisionsBackend(
  resolvedConfig: ReviewerConfig,
  reasoningReview: () => Promise<ReviewExecutionResult>,
): V2ReviewBackend {
  const reviewer = new DecisionsReviewerBackend({
    config: resolvedConfig,
    transport: async ({ onRequestSent }) => {
      onRequestSent()
      return systemOneResponse("acme/jev-primary-20261013")
    },
    reasoning: {
      model: resolvedConfig.reasoningModels![0]!.model,
      review: async () => reasoningReview(),
    },
  })
  return {
    owns: () => false,
    review: (envelope, attempt, client) => reviewer.review(envelope, attempt, client),
    waitForIdle: () => reviewer.waitForIdle(),
    dispose: () => reviewer.waitForIdle(),
  }
}

async function fixture(
  options: {
    result?: ReviewExecutionResult
    delay?: Promise<void>
    connectionError?: boolean
    budget?: number
    hostVersion?: string
    reviewerModel?: string
    decisionModels?: string[]
    reasoningModels?: ReviewerConfig["reasoningModels"]
    resolvedConfig?: ReviewerConfig
    decisionTrace?: DecisionRoutingTrace
    finalizeTraceOnAbort?: boolean
    configDegraded?: string[]
    escalationMode?: ReviewerConfig["escalationMode"]
    reviewError?: Error
    configOverrides?: Partial<ReviewerConfig>
    publishFails?: boolean
    contextError?: boolean
    createBackend?: (config: ReviewerConfig) => V2ReviewBackend
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "reviewer-server-contract-"))
  const auditPath = join(directory, "audit.jsonl")
  let evaluate!: (input: Input) => Promise<void>
  let rpc!: {
    identity(): Promise<string>
    status(): Promise<Record<string, unknown>>
    snapshot(): Promise<{ reviews: unknown[] }>
  }
  let resume: (() => void) | undefined
  const events: OpenCodeEvent[] = []
  let ended = false
  let reviews = 0
  let registrationDisposals = 0
  const toolHooks = new Map<string, (event: unknown) => void>()
  const registration = () => ({
    dispose: async () => {
      registrationDisposals++
    },
  })
  const ctx = {
    app: { version: options.hostVersion ?? "2.2.0" },
    options: {},
    location: { directory, project: { directory } },
    rpc: {
      register: async (_definition: unknown, handlers: typeof rpc) => {
        rpc = handlers
        return {
          events: {
            emit: async () => {
              if (options.publishFails) throw new Error("TUI event channel is down")
            },
          },
          ...registration(),
        }
      },
    },
    tool: {
      hook: async (name: string, callback: (event: unknown) => void) => {
        toolHooks.set(name, callback)
        return registration()
      },
    },
    permission: {
      hook: async (_name: string, callback: typeof evaluate) => {
        evaluate = callback
        return registration()
      },
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID,
        location: { directory },
        time: { created: 1 },
      }),
    },
    event: {
      subscribe: async function* ({ signal }: { signal: AbortSignal }) {
        const wake = () => resume?.()
        signal.addEventListener("abort", wake)
        try {
          while (!signal.aborted && !ended) {
            if (events.length) yield events.shift()!
            else
              await new Promise<void>((resolve) => {
                resume = resolve
              })
          }
        } finally {
          signal.removeEventListener("abort", wake)
        }
      },
    },
  } as unknown as Parameters<typeof setupWithServices>[0]
  const client = {
    session: {
      get: ctx.session.get,
      context: async () => {
        if (options.contextError) throw new Error("database unavailable")
        return [{ type: "user", id: "msg_user", text: "Run printf safe", time: { created: 2 } }]
      },
    },
  } as unknown as OpenCodeClient
  const dispose = await setupWithServices(ctx, {
    loadConfig: () => {
      return (
        options.resolvedConfig ??
        config({
          audit: true,
          auditPath,
          reviewBudgetMs: options.budget ?? 5000,
          decisionModels: options.decisionModels ?? ["opencode/jev-1.13-free"],
          reasoningModels: options.reasoningModels ?? [
            {
              model: "openai/gpt-6-luna",
              variant: "medium",
              outputFormat: "json_schema",
              timeoutMs: 120_000,
            },
          ],
          ...(options.configDegraded ? { configDegraded: options.configDegraded } : {}),
          ...(options.escalationMode ? { escalationMode: options.escalationMode } : {}),
          ...(options.reviewerModel ? { model: options.reviewerModel } : {}),
          ...options.configOverrides,
        })
      )
    },
    connect: async () => {
      if (options.connectionError) throw new Error("Connection identity mismatch")
      return client
    },
    createBackend: (_context, resolvedConfig) => {
      if (options.createBackend) {
        const backend = options.createBackend(resolvedConfig)
        return {
          owns: (sessionID) => backend.owns(sessionID),
          waitForIdle: () => backend.waitForIdle(),
          dispose: () => backend.dispose(),
          review: async (envelope, attempt, client) => {
            reviews++
            return backend.review(envelope, attempt, client)
          },
        }
      }
      return {
        owns: () => false,
        waitForIdle: async () => {},
        dispose: async () => {},
        review: async (envelope, attempt) => {
          reviews++
          if (options.decisionTrace) {
            envelope.decisionTrace = options.decisionTrace
            if (options.finalizeTraceOnAbort) {
              attempt.signal.addEventListener(
                "abort",
                () => {
                  const last = options.decisionTrace!.attempts.at(-1)
                  if (last) last.outcome = attempt.state === "expired" ? "deadline" : "cancelled"
                },
                { once: true },
              )
            }
          }
          await options.delay
          if (options.reviewError) throw options.reviewError
          return (
            options.result ?? {
              kind: "allow",
              reason: "Fixture decision",
              decision: decision("allow"),
              decisionSource: "llm-reviewer",
            }
          )
        },
      }
    },
  })
  const input = (sessionID = "ses_main"): Input => ({
    action: "shell",
    resources: ["printf *"],
    metadata: { command: "printf safe" },
    sessionID,
    effect: "ask",
  })
  return {
    evaluate: (value: Input) => evaluate(value),
    input,
    rpc,
    directory,
    reviews: () => reviews,
    registrationDisposals: () => registrationDisposals,
    endEvents: () => {
      ended = true
      resume?.()
    },
    event: (sessionID: string, location = directory) => {
      events.push({
        type: "session.execution.interrupted",
        data: { sessionID },
        location: { directory: location },
      } as OpenCodeEvent)
      resume?.()
    },
    push: async (event: OpenCodeEvent) => {
      events.push(event)
      resume?.()
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
    tool: (name: string, event: unknown) => toolHooks.get(name)?.(event),
    dispose,
    records: async () =>
      (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    cleanup: async () => {
      await dispose()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

test("V2 audit and UI preserve ordered Decisions-to-reasoning attribution", async () => {
  const model = "openrouter/acme/jev-primary"
  const responseModel = "acme/jev-primary-20261013"
  const reasoningModel = "openai/gpt-6-luna"
  const harness = await fixture({
    decisionModels: [model],
    reasoningModels: [
      {
        model: reasoningModel,
        variant: "medium",
        outputFormat: "json_schema",
        timeoutMs: 120_000,
      },
    ],
    decisionTrace: {
      attempts: [
        {
          model,
          modelIndex: 0,
          attempt: 1,
          requestSent: true,
          outcome: "valid-decision",
          durationMs: 19,
          responseModel,
        },
      ],
      reviewerModel: reasoningModel,
      reviewerEscalatedFrom: { model, reason: "System One requested reasoning" },
      responseModel,
    },
    result: {
      kind: "allow",
      reason: "Reasoning decision",
      decision: decision("allow"),
      decisionSource: "llm-reviewer",
    },
  })
  try {
    const input = harness.input()
    await harness.evaluate(input)
    expect(input.effect).toBe("allow")
    const reviews = (await harness.rpc.snapshot()).reviews as Array<{
      model: string
      variant: string
    }>
    expect(reviews.at(-1)?.model).toBe(reasoningModel)
    expect(reviews.at(-1)?.variant).toBe("medium")
    await harness.dispose()
    const record = (await harness.records())[0]
    expect(record).toMatchObject({
      reviewerModel: reasoningModel,
      reviewerEscalatedFrom: { model, reason: "System One requested reasoning" },
      responseModel,
      decisionAttempts: [{ model, outcome: "valid-decision", responseModel }],
    })
  } finally {
    await harness.cleanup()
  }
})

test("V2 UI and audit cannot infer paid Jev from default Free-only fallback metadata", async () => {
  const harness = await fixture({
    reviewerModel: "opencode/jev-1.13-free",
    result: {
      kind: "allow",
      reason: "Legacy fallback metadata must not choose a V2 reviewer",
      decision: decision("allow"),
      decisionSource: "system-one-reviewer",
      reviewerModel: "openrouter/typesafe/jev-1.13",
      fallbackFrom: "opencode/jev-1.13-free",
      fallbackReason: "rate-limited",
      fallbackAttempts: 3,
    },
  })
  try {
    await harness.evaluate(harness.input())
    const reviews = (await harness.rpc.snapshot()).reviews as Array<{
      model: string
      variant: string
    }>
    expect(reviews.at(-1)?.model).toBe("opencode/jev-1.13-free")
    expect(reviews.at(-1)?.variant).toBe("system-one")
    await harness.dispose()
    const record = (await harness.records())[0]
    expect(record?.reviewerModel).toBeUndefined()
    expect(record?.fallbackFrom).toBe("opencode/jev-1.13-free")
    expect(record?.fallbackReason).toBe("rate-limited")
    expect(record?.fallbackAttempts).toBe(3)
  } finally {
    await harness.cleanup()
  }
})

test("server maps decisions without elevating existing allow or deny and reports application independently", async () => {
  for (const kind of ["allow", "deny", "escalate"] as const) {
    const harness = await fixture({
      result: {
        kind,
        reason: "Fixture outcome",
        decision: decision(kind),
        decisionSource: "llm-reviewer",
      },
    })
    try {
      for (const effect of ["allow", "deny"] as const) {
        const unchanged = { ...harness.input(), effect }
        await harness.evaluate(unchanged)
        expect(unchanged.effect).toBe(effect)
      }
      expect(harness.reviews()).toBe(0)
      const input = harness.input()
      await harness.evaluate(input)
      expect(input.effect).toBe(kind === "escalate" ? "ask" : kind)
      expect(harness.reviews()).toBe(1)
      expect((await harness.rpc.snapshot()).reviews).toHaveLength(1)
      expect(await harness.rpc.status()).toMatchObject({
        host: "v2",
        pending: 0,
        connection: "verified",
      })
      expect(await harness.rpc.identity()).toBeTruthy()
      await harness.dispose()
      expect(harness.registrationDisposals()).toBe(4)
      expect((await harness.records())[0]?.application).toBe(
        kind === "escalate" ? "human-pending" : "evaluation-returned",
      )
      const after = harness.input()
      await harness.evaluate(after)
      expect(after.effect).toBe("deny")
    } finally {
      await harness.cleanup()
    }
  }
})

test("deadline, interrupted session, event loss, and shutdown suppress late approvals", async () => {
  for (const interruption of ["deadline", "session", "event-loss", "shutdown"] as const) {
    let release!: () => void
    const delay = new Promise<void>((resolve) => {
      release = resolve
    })
    const harness = await fixture({ delay, budget: interruption === "deadline" ? 20 : 5000 })
    try {
      const input = harness.input()
      const work = harness.evaluate(input)
      while (harness.reviews() === 0) await Bun.sleep(1)
      harness.event("ses_main", "/another-location")
      await Bun.sleep(1)
      expect(input.effect).toBe("ask")
      if (interruption === "session") harness.event("ses_main")
      if (interruption === "event-loss") harness.endEvents()
      if (interruption === "shutdown") await harness.dispose()
      await work
      expect(input.effect).toBe("deny")
      release()
      await Bun.sleep(1)
      expect(input.effect).toBe("deny")
    } finally {
      release()
      await harness.cleanup()
    }
  }
})

test("overload stays bounded and independent sessions keep independent outcomes", async () => {
  let release!: () => void
  const harness = await fixture({
    delay: new Promise<void>((resolve) => {
      release = resolve
    }),
  })
  try {
    const inputs = Array.from({ length: 32 }, (_, index) => harness.input(`ses_${index}`))
    const work = Promise.all(inputs.map(harness.evaluate))
    while (harness.reviews() < 32) await Bun.sleep(1)
    const overload = harness.input("ses_overload")
    await harness.evaluate(overload)
    expect(overload.effect).toBe("deny")
    expect((await harness.rpc.status()).pending).toBe(32)
    harness.event("ses_0")
    release()
    await work
    expect(inputs[0]?.effect).toBe("deny")
    expect(inputs.slice(1).every((input) => input.effect === "allow")).toBe(true)
  } finally {
    release()
    await harness.cleanup()
  }
})

test("v2 host setup enforces the supported range and reports it", async () => {
  for (const version of ["2.2.0", "2.2.1", "2.3.0"]) {
    const harness = await fixture({ hostVersion: version })
    try {
      expect(await harness.rpc.status()).toMatchObject({ host: "v2", hostVersion: version })
    } finally {
      await harness.cleanup()
    }
  }
  for (const version of ["2.1.4", "3.0.0", "2.2.0-beta.1"]) {
    const ctx = {
      app: { version },
      location: { directory: "/tmp", project: { directory: "/tmp" } },
    } as unknown as Parameters<typeof setupWithServices>[0]
    const services = {
      loadConfig: () => {
        throw new Error("setup must reject the host before loading config")
      },
      connect: () => {
        throw new Error("setup must reject the host before connecting")
      },
      createBackend: () => {
        throw new Error("setup must reject the host before creating a backend")
      },
    } as unknown as Parameters<typeof setupWithServices>[1]
    await expect(setupWithServices(ctx, services)).rejects.toThrow(
      `Unsupported OpenCode V2 host ${version}; supported range is >=2.2.0 <3`,
    )
  }
})

test("V2 status and config hash describe decision and reasoning routes, not legacy model fields", async () => {
  const decisionModels = ["openrouter/acme/jev-primary", "opencode/jev-1.13-free"]
  const reasoningModels = [
    {
      model: "openai/gpt-6-luna",
      variant: "low",
      outputFormat: "text" as const,
      timeoutMs: 30_000,
    },
  ]
  const resolvedConfig = resolveConfig({
    model: "openai/ignored-legacy-model",
    variant: "ignored-legacy-variant",
    outputFormat: "json_schema",
    decisionModels,
    reasoningModels,
  })
  const harness = await fixture({ resolvedConfig })
  try {
    const status = await harness.rpc.status()
    expect(status).toMatchObject({
      host: "v2",
      model: decisionModels[0],
      decisionModels,
      reasoningModels,
      variant: "low",
      outputFormat: "text",
    })

    const legacyChanged = await fixture({
      resolvedConfig: { ...resolvedConfig, model: "typesafe-ai/jev-legacy", variant: "other" },
    })
    try {
      expect((await legacyChanged.rpc.status()).effectiveConfigHash).toBe(
        status.effectiveConfigHash,
      )
    } finally {
      await legacyChanged.cleanup()
    }

    const routeChanged = await fixture({
      resolvedConfig: {
        ...resolvedConfig,
        decisionModels: ["openrouter/acme/jev-secondary"],
      },
    })
    try {
      expect((await routeChanged.rpc.status()).effectiveConfigHash).not.toBe(
        status.effectiveConfigHash,
      )
    } finally {
      await routeChanged.cleanup()
    }
  } finally {
    await harness.cleanup()
  }
})

test("V2 final audit attributes the selected route across allow, deny, and escalation", async () => {
  const model = "openrouter/acme/jev-primary"
  const responseModel = "acme/jev-primary-20261013"
  for (const kind of ["allow", "deny", "escalate"] as const) {
    const harness = await fixture({
      decisionModels: [model],
      decisionTrace: {
        attempts: [
          {
            model,
            modelIndex: 0,
            attempt: 1,
            requestSent: true,
            outcome: "valid-decision",
            durationMs: 19,
            responseModel,
          },
        ],
        reviewerModel: model,
        responseModel,
      },
      result: {
        kind,
        reason: "Fixture outcome",
        decision: decision(kind),
        decisionSource: "llm-reviewer",
      },
    })
    try {
      const input = harness.input()
      await harness.evaluate(input)
      expect(input.effect).toBe(kind === "escalate" ? "ask" : kind)
      await harness.dispose()
      expect(await harness.records()).toMatchObject([
        {
          outcome: kind,
          reviewerModel: model,
          responseModel,
          decisionAttempts: [
            {
              model,
              modelIndex: 0,
              attempt: 1,
              requestSent: true,
              outcome: "valid-decision",
              responseModel,
            },
          ],
        },
      ])
    } finally {
      await harness.cleanup()
    }
  }
})

test("successful reasoning provenance survives the real degraded-config denial gate", async () => {
  const model = "openrouter/acme/jev-primary"
  const responseModel = "acme/jev-primary-20261013"
  const reasoningModel = "openai/gpt-6-luna"
  const harness = await fixture({
    decisionModels: [model],
    configDegraded: ["trusted decision route config is invalid"],
    escalationMode: "deny",
    createBackend: (resolvedConfig) =>
      decisionsBackend(resolvedConfig, async () => ({
        kind: "allow",
        reason: "Reasoning reviewer approved",
        decision: decision("allow"),
        decisionSource: "llm-reviewer",
      })),
  })
  try {
    const input = harness.input()
    await harness.evaluate(input)
    expect(input.effect).toBe("deny")
    const reviews = (await harness.rpc.snapshot()).reviews as Array<{
      model: string
      variant: string
    }>
    expect(reviews.at(-1)).toMatchObject({ model: reasoningModel, variant: "medium" })
    await harness.dispose()
    const record = (await harness.records())[0]!
    expect(record).toMatchObject({
      outcome: "deny",
      escalationDisposition: "deny",
      reviewerModel: reasoningModel,
      reviewerEscalatedFrom: { model, reason: expect.any(String) },
      responseModel,
      decisionAttempts: [{ model, outcome: "valid-decision", responseModel }],
    })
    expect(Object.keys(record.reviewerEscalatedFrom as object).sort()).toEqual(["model", "reason"])
  } finally {
    await harness.cleanup()
  }
})

test("successful reasoning provenance survives the real incomplete-evidence gate", async () => {
  const model = "openrouter/acme/jev-primary"
  const responseModel = "acme/jev-primary-20261013"
  const reasoningModel = "openai/gpt-6-luna"
  const harness = await fixture({
    decisionModels: [model],
    createBackend: (resolvedConfig) =>
      decisionsBackend(resolvedConfig, async () => ({
        kind: "allow",
        reason: "Reasoning reviewer approved",
        decision: decision("allow"),
        decisionSource: "llm-reviewer",
      })),
  })
  try {
    const input = { ...harness.input(), action: "edit", metadata: {} }
    await harness.evaluate(input)
    expect(input.effect).toBe("ask")
    const reviews = (await harness.rpc.snapshot()).reviews as Array<{
      model: string
      variant: string
    }>
    expect(reviews.at(-1)).toMatchObject({ model: reasoningModel, variant: "medium" })
    await harness.dispose()
    expect(await harness.records()).toMatchObject([
      {
        outcome: "escalate",
        application: "human-pending",
        reviewerModel: reasoningModel,
        reviewerEscalatedFrom: { model, reason: expect.any(String) },
        responseModel,
        decisionAttempts: [{ model, outcome: "valid-decision", responseModel }],
      },
    ])
  } finally {
    await harness.cleanup()
  }
})

test("successful reasoning provenance survives pending-action replacement", async () => {
  const model = "openrouter/acme/jev-primary"
  const responseModel = "acme/jev-primary-20261013"
  const reasoningModel = "openai/gpt-6-luna"
  let release!: () => void
  let markStarted!: () => void
  const started = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  const reasoningPending = new Promise<void>((resolve) => {
    release = resolve
  })
  const harness = await fixture({
    decisionModels: [model],
    createBackend: (resolvedConfig) =>
      decisionsBackend(resolvedConfig, async () => {
        markStarted()
        await reasoningPending
        return {
          kind: "allow",
          reason: "Reasoning reviewer approved",
          decision: decision("allow"),
          decisionSource: "llm-reviewer",
        }
      }),
  })
  try {
    const input = harness.input()
    const work = harness.evaluate(input)
    await started
    Reflect.set(input, "metadata", { command: "printf changed" })
    release()
    await work
    expect(input.effect).toBe("deny")
    expect(input.message).toContain("changed during")
    const reviews = (await harness.rpc.snapshot()).reviews as Array<{
      model: string
      variant: string
    }>
    expect(reviews.at(-1)).toMatchObject({ model: reasoningModel, variant: "medium" })
    await harness.dispose()
    expect(await harness.records()).toMatchObject([
      {
        outcome: "deny",
        reviewerModel: reasoningModel,
        reviewerEscalatedFrom: { model, reason: expect.any(String) },
        responseModel,
        decisionAttempts: [{ model, outcome: "valid-decision", responseModel }],
      },
    ])
  } finally {
    release()
    await harness.cleanup()
  }
})

test("V2 audit snapshots the synchronously finalized cancellation trace", async () => {
  let release!: () => void
  const model = "openrouter/acme/jev-primary"
  const trace: DecisionRoutingTrace = {
    attempts: [
      {
        model,
        modelIndex: 0,
        attempt: 1,
        requestSent: true,
        outcome: "network-error",
        durationMs: 5,
      },
    ],
  }
  const harness = await fixture({
    decisionModels: [model],
    decisionTrace: trace,
    finalizeTraceOnAbort: true,
    delay: new Promise<void>((resolve) => {
      release = resolve
    }),
  })
  try {
    const input = harness.input()
    const work = harness.evaluate(input)
    while (harness.reviews() === 0) await Bun.sleep(1)
    harness.event("ses_main")
    await work
    expect(input.effect).toBe("deny")
    expect(harness.reviews()).toBe(1)
    await harness.dispose()
    expect(await harness.records()).toMatchObject([
      {
        outcome: "deny",
        application: "cancelled",
        decisionAttempts: [
          {
            model,
            requestSent: true,
            outcome: "cancelled",
          },
        ],
      },
    ])
  } finally {
    release()
    await harness.cleanup()
  }
})

test("V2 audit snapshots the in-flight attempt at the overall review deadline", async () => {
  let release!: () => void
  const model = "openrouter/acme/jev-primary"
  const trace: DecisionRoutingTrace = {
    attempts: [
      {
        model,
        modelIndex: 0,
        attempt: 1,
        requestSent: true,
        outcome: "network-error",
        durationMs: 5,
      },
    ],
  }
  const harness = await fixture({
    budget: 20,
    decisionModels: [model],
    decisionTrace: trace,
    finalizeTraceOnAbort: true,
    delay: new Promise<void>((resolve) => {
      release = resolve
    }),
  })
  try {
    const input = harness.input()
    const work = harness.evaluate(input)
    while (harness.reviews() === 0) await Bun.sleep(1)
    await work
    expect(input.effect).toBe("deny")
    expect(harness.reviews()).toBe(1)
    await harness.dispose()
    expect(await harness.records()).toMatchObject([
      {
        outcome: "deny",
        application: "cancelled",
        decisionAttempts: [
          {
            model,
            requestSent: true,
            outcome: "deadline",
          },
        ],
      },
    ])
  } finally {
    release()
    await harness.cleanup()
  }
})

test("decision trace survives the server's pending-action fail-closed replacement", async () => {
  let release!: () => void
  const model = "opencode/jev-1.13-free"
  const responseModel = "jev-1.13-free"
  const harness = await fixture({
    decisionModels: [model],
    decisionTrace: {
      attempts: [
        {
          model,
          modelIndex: 0,
          attempt: 1,
          requestSent: true,
          outcome: "valid-decision",
          durationMs: 12,
          responseModel,
        },
      ],
      reviewerModel: model,
      responseModel,
    },
    delay: new Promise<void>((resolve) => {
      release = resolve
    }),
  })
  try {
    const input = harness.input()
    const work = harness.evaluate(input)
    while (harness.reviews() === 0) await Bun.sleep(1)
    Reflect.set(input, "metadata", { command: "printf changed" })
    release()
    await work
    expect(input.effect).toBe("deny")
    await harness.dispose()
    expect(await harness.records()).toMatchObject([
      {
        outcome: "deny",
        decisionAttempts: [{ model, outcome: "valid-decision", responseModel }],
        reviewerModel: model,
        responseModel,
      },
    ])
  } finally {
    release()
    await harness.cleanup()
  }
})

test("V2 audit retains route metadata when a degraded-config gate replaces allow", async () => {
  const model = "openrouter/acme/jev-primary"
  const responseModel = "acme/jev-primary-20261013"
  const harness = await fixture({
    decisionModels: [model],
    configDegraded: ["trusted decision route config is invalid"],
    escalationMode: "deny",
    decisionTrace: {
      attempts: [
        {
          model,
          modelIndex: 0,
          attempt: 1,
          requestSent: true,
          outcome: "valid-decision",
          durationMs: 15,
          responseModel,
        },
      ],
      reviewerModel: model,
      responseModel,
    },
    result: {
      kind: "allow",
      reason: "Fixture allow",
      decision: decision("allow"),
      decisionSource: "llm-reviewer",
    },
  })
  try {
    const input = harness.input()
    await harness.evaluate(input)
    expect(input.effect).toBe("deny")
    await harness.dispose()
    expect(await harness.records()).toMatchObject([
      {
        outcome: "deny",
        escalationDisposition: "deny",
        decisionAttempts: [{ model, outcome: "valid-decision", responseModel }],
        reviewerModel: model,
        responseModel,
      },
    ])
  } finally {
    await harness.cleanup()
  }
})

test("reviewer failure metadata does not claim a successful reviewer model", async () => {
  const model = "openrouter/acme/jev-primary"
  const harness = await fixture({
    decisionModels: [model],
    decisionTrace: {
      attempts: [
        {
          model,
          modelIndex: 0,
          attempt: 1,
          requestSent: true,
          outcome: "network-error",
          durationMs: 11,
        },
      ],
    },
    reviewError: new Error("synthetic route failure"),
  })
  try {
    const input = harness.input()
    await harness.evaluate(input)
    expect(input.effect).toBe("ask")
    await harness.dispose()
    const record = (await harness.records())[0]
    expect(record).toMatchObject({
      outcome: "escalate",
      decisionAttempts: [{ model, outcome: "network-error", requestSent: true }],
    })
    expect(record?.reviewerModel).toBeUndefined()
    expect(record?.responseModel).toBeUndefined()
  } finally {
    await harness.cleanup()
  }
})

test("invalid-decision disposition keeps its closed trace without reviewer attribution", async () => {
  const model = "opencode/jev-1.13-free"
  const harness = await fixture({
    decisionModels: [model],
    decisionTrace: {
      attempts: [
        {
          model,
          modelIndex: 0,
          attempt: 2,
          requestSent: true,
          outcome: "invalid-decision",
          durationMs: 21,
          httpStatus: 200,
        },
      ],
    },
    result: {
      kind: "deny",
      reason: "Invalid reviewer decision under configured deny behavior",
      decisionSource: "failure-safe",
      escalationDisposition: "deny",
    },
  })
  try {
    const input = harness.input()
    await harness.evaluate(input)
    expect(input.effect).toBe("deny")
    await harness.dispose()
    const record = (await harness.records())[0]
    expect(record).toMatchObject({
      outcome: "deny",
      decisionAttempts: [
        { model, attempt: 2, outcome: "invalid-decision", httpStatus: 200, requestSent: true },
      ],
    })
    expect(record?.reviewerModel).toBeUndefined()
    expect(record?.responseModel).toBeUndefined()
  } finally {
    await harness.cleanup()
  }
})

test("action mutations and incomplete evidence cannot reuse an approval, and connection failures stay visible", async () => {
  let release!: () => void
  const changing = await fixture({
    delay: new Promise<void>((resolve) => {
      release = resolve
    }),
  })
  try {
    const input = changing.input()
    const work = changing.evaluate(input)
    while (changing.reviews() === 0) await Bun.sleep(1)
    Reflect.set(input, "metadata", { command: "printf changed" })
    release()
    await work
    expect(input.effect).toBe("deny")
    expect(input.message).toContain("changed during")
  } finally {
    release()
    await changing.cleanup()
  }
  for (const connectionError of [false, true]) {
    const harness = await fixture({ connectionError })
    try {
      const input = harness.input()
      Reflect.set(input, "metadata", {})
      await harness.evaluate(input)
      expect(input.effect).not.toBe("allow")
      if (connectionError)
        expect(await harness.rpc.status()).toMatchObject({ connection: "failed" })
    } finally {
      await harness.cleanup()
    }
  }
})

const readOnlyRule = (effect: "deny" | "manual") =>
  ({
    id: `${effect}-read-only`,
    source: "global" as const,
    when: { actionClass: ["read-only"] },
    effect,
    reason: `test ${effect} rule`,
  }) as PolicyRule

test("a failing UI publish channel never changes the safety decision", async () => {
  for (const kind of ["allow", "deny", "escalate"] as const) {
    const harness = await fixture({
      publishFails: true,
      result: { kind, reason: "Fixture", decision: decision(kind), decisionSource: "llm-reviewer" },
    })
    try {
      const input = harness.input()
      await harness.evaluate(input)
      expect(input.effect).toBe(kind === "escalate" ? "ask" : kind)
      await harness.dispose()
      expect((await harness.records())[0]?.outcome).toBe(kind)
    } finally {
      await harness.cleanup()
    }
  }
})

test("escalationMode deny turns a reviewer escalate into a deny and audits both outcomes", async () => {
  const harness = await fixture({
    escalationMode: "deny",
    result: {
      kind: "escalate",
      reason: "Scope is ambiguous",
      decision: decision("escalate"),
      decisionSource: "llm-reviewer",
    },
  })
  try {
    const input = harness.input()
    await harness.evaluate(input)
    expect(input.effect).toBe("deny")
    expect(input.message).toBe("Scope is ambiguous")
    await harness.dispose()
    expect((await harness.records())[0]).toMatchObject({
      outcome: "deny",
      reviewerOutcome: "escalate",
      escalationDisposition: "deny",
      application: "evaluation-returned",
    })
  } finally {
    await harness.cleanup()
  }
})

test("a reviewer failure under escalationMode deny audits no invented decision fields", async () => {
  const harness = await fixture({
    escalationMode: "deny",
    result: { kind: "escalate", reason: "Reviewer timed out", decisionSource: "failure-safe" },
  })
  try {
    const input = harness.input()
    await harness.evaluate(input)
    expect(input.effect).toBe("deny")
    await harness.dispose()
    const record = (await harness.records())[0]!
    expect(record).toMatchObject({ outcome: "deny", escalationDisposition: "deny" })
    for (const field of ["reviewerOutcome", "riskLevel", "confidence", "userAuthorization"])
      expect(record).not.toHaveProperty(field)
  } finally {
    await harness.cleanup()
  }
})

test("default manual mode leaves an escalate for a human and audits the manual disposition", async () => {
  const harness = await fixture({
    result: {
      kind: "escalate",
      reason: "Needs a human",
      decision: decision("escalate"),
      decisionSource: "llm-reviewer",
    },
  })
  try {
    const input = harness.input()
    await harness.evaluate(input)
    expect(input.effect).toBe("ask")
    await harness.dispose()
    expect((await harness.records())[0]).toMatchObject({
      outcome: "escalate",
      escalationDisposition: "manual",
      application: "human-pending",
    })
  } finally {
    await harness.cleanup()
  }
})

test("an explicit allow audit carries host identity, reviewer fields and no escalation disposition", async () => {
  const harness = await fixture({ escalationMode: "deny" })
  try {
    await harness.evaluate(harness.input())
    await harness.dispose()
    const record = (await harness.records())[0]!
    expect(record).toMatchObject({
      schemaVersion: 3,
      decisionSchemaVersion: 2,
      hostGeneration: "v2",
      outcome: "allow",
      decisionSource: "llm-reviewer",
      reviewerOutcome: "allow",
      scopeAlignment: "aligned",
      application: "evaluation-returned",
    })
    expect(record.riskLevel).toBeString()
    expect(record.userAuthorization).toBeString()
    expect(record.confidence).toBeNumber()
    expect(record.promptVersion).toBeString()
    expect(record.actionFingerprint).toMatch(/^v2:[0-9a-f]{64}$/)
    expect(record.reviewID).toBe(record.requestID)
    expect(record).not.toHaveProperty("escalationDisposition")
  } finally {
    await harness.cleanup()
  }
})

test("policy trace and resolved actor reach the audit record", async () => {
  const harness = await fixture()
  try {
    await harness.evaluate(harness.input())
    await harness.dispose()
    const record = (await harness.records())[0]!
    expect(record.policyTrace).toMatchObject({ mode: "observe", finalRoute: "review" })
    expect(
      (record.policyTrace as { effectivePolicyHash: string }).effectivePolicyHash,
    ).toHaveLength(16)
    expect(record.rootSessionID).toBe("ses_main")
    expect(record.actor).toMatchObject({ profile: expect.any(String) })
  } finally {
    await harness.cleanup()
  }
})

test("enforce mode deny and manual rules skip the reviewer", async () => {
  for (const effect of ["deny", "manual"] as const) {
    const harness = await fixture({
      configOverrides: { enforcementMode: "enforce", policyRules: [readOnlyRule(effect)] },
    })
    try {
      const input = harness.input()
      await harness.evaluate(input)
      expect(input.effect).toBe(effect === "deny" ? "deny" : "ask")
      expect(harness.reviews()).toBe(0)
      await harness.dispose()
      expect((await harness.records())[0]).toMatchObject({
        decisionSource: "deterministic-policy",
        policyTrace: { finalRoute: effect, mode: "enforce" },
      })
    } finally {
      await harness.cleanup()
    }
  }
})

test("observe mode audits the counterfactual deny route but still reviews and allows", async () => {
  const harness = await fixture({
    configOverrides: { enforcementMode: "observe", policyRules: [readOnlyRule("deny")] },
  })
  try {
    const input = harness.input()
    await harness.evaluate(input)
    expect(input.effect).toBe("allow")
    expect(harness.reviews()).toBe(1)
    await harness.dispose()
    expect((await harness.records())[0]?.policyTrace).toMatchObject({
      mode: "observe",
      finalRoute: "deny",
    })
  } finally {
    await harness.cleanup()
  }
})

test("reviewer sessions requesting permissions are denied without a model call", async () => {
  const harness = await fixture({
    createBackend: () => ({
      owns: (sessionID) => sessionID === "ses_reviewer",
      waitForIdle: async () => {},
      dispose: async () => {},
      review: async () => {
        throw new Error("must not be called")
      },
    }),
  })
  try {
    const input = harness.input("ses_reviewer")
    await harness.evaluate(input)
    expect(input.effect).toBe("deny")
    expect(harness.reviews()).toBe(0)
    await harness.dispose()
    expect((await harness.records())[0]).toMatchObject({
      outcome: "deny",
      decisionSource: "emergency-brake",
      riskLevel: "critical",
    })
  } finally {
    await harness.cleanup()
  }
})

test("the emergency brake and static-analysis budgets deny before any model call", async () => {
  const commands = [
    "rm -rf /",
    `${"env -S ".repeat(33)}rm -rf /`,
    Array.from({ length: 9_000 }, (_, i) => `echo segment-${i}`).join(";"),
  ]
  for (const command of commands) {
    const harness = await fixture()
    try {
      const input = { ...harness.input(), metadata: { command }, resources: [command] }
      await harness.evaluate(input)
      expect(input.effect).toBe("deny")
      expect(harness.reviews()).toBe(0)
    } finally {
      await harness.cleanup()
    }
  }
})

test("an allow over an elided long command escalates instead of approving", async () => {
  const command = `printf '${"x".repeat(9_000)}' ; rm -rf /tmp/scratch ; echo ${"y".repeat(9_000)}`
  const harness = await fixture()
  try {
    const input = { ...harness.input(), metadata: { command }, resources: [command] }
    await harness.evaluate(input)
    expect(input.effect).toBe("ask")
    expect(input.message).toContain("elided or truncated")
  } finally {
    await harness.cleanup()
  }
})

test("transcript retrieval failure never approves", async () => {
  const harness = await fixture({ contextError: true })
  try {
    const input = harness.input()
    await harness.evaluate(input)
    expect(input.effect).not.toBe("allow")
  } finally {
    await harness.cleanup()
  }
})

test("a failure after evidence collection still audits the ssh summary with phase and cause", async () => {
  const command = "ssh -p 2222 ubuntu@203.0.113.8 'docker ps'"
  const harness = await fixture({ reviewError: new Error("backend exploded") })
  try {
    const input = { ...harness.input(), metadata: { command }, resources: [command] }
    await harness.evaluate(input)
    expect(input.effect).not.toBe("allow")
    await harness.dispose()
    expect((await harness.records())[0]).toMatchObject({
      decisionSource: "failure-safe",
      ssh: [{ destination: "ubuntu@203.0.113.8", port: "2222" }],
    })
    expect(input.message).toContain("permission review hook")
    expect(input.message).toContain("backend exploded")
  } finally {
    await harness.cleanup()
  }
})

test("captured ask decisions reach the audit capped to the latest five, and the knob disables them", async () => {
  for (const askDecisions of [true, false]) {
    const harness = await fixture({ configOverrides: { askDecisions } })
    try {
      const at = (type: string, data: unknown) =>
        ({ type, data, location: { directory: harness.directory } }) as OpenCodeEvent
      for (let index = 0; index < 7; index++) {
        const form = {
          id: `form_${index}`,
          sessionID: "ses_main",
          title: "Scope",
          fields: [{ key: "scope", title: "Pick", type: "string" }],
        }
        await harness.push(at("form.created", { form }))
        await harness.push(
          at("form.replied", {
            id: form.id,
            sessionID: "ses_main",
            answer: { scope: `answer-${index}` },
          }),
        )
      }
      await harness.evaluate(harness.input())
      await harness.dispose()
      const recorded = (await harness.records())[0]!.askDecisions as
        Array<{ answer: string }> | undefined
      if (askDecisions)
        expect(recorded?.map((entry) => entry.answer)).toEqual(
          [2, 3, 4, 5, 6].map((index) => `answer-${index}`),
        )
      else expect(recorded).toBeUndefined()
    } finally {
      await harness.cleanup()
    }
  }
})
