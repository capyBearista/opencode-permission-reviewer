import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createAuditWriter } from "../src/audit.ts"
import { DEFAULT_CONFIG, isValidDecisionsModel } from "../src/config.ts"
import type { ReviewAuditRecord, ReviewerConfig } from "../src/types.ts"

const model = "openrouter/acme/jev-primary"
const responseModel = "acme/jev-primary-20261013"

function record(overrides: Partial<ReviewAuditRecord> = {}): ReviewAuditRecord {
  return {
    timestamp: new Date().toISOString(),
    durationMs: 30,
    requestID: "review-1",
    sessionID: "session-1",
    permission: "bash",
    outcome: "allow",
    reason: "review completed",
    ...overrides,
  }
}

test("V2 audit persists only bounded closed attempt metadata and verified identities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "permission-reviewer-v2-audit-"))
  const auditPath = join(directory, "audit.jsonl")
  const config: ReviewerConfig = {
    ...DEFAULT_CONFIG,
    auditPath,
    decisionModels: [model],
    reasoningModels: [
      {
        model: "openai/gpt-6-luna",
        variant: "medium",
        outputFormat: "json_schema",
        timeoutMs: 120_000,
      },
    ],
  }
  try {
    const writer = createAuditWriter(config)!
    const attempts: unknown[] = Array.from({ length: 41 }, (_, index) => ({
      model,
      modelIndex: 0,
      attempt: (index % 5) + 1,
      requestSent: true,
      outcome: "valid-decision",
      durationMs: 12,
      ...(index === 0 ? { responseModel } : {}),
      providerError: "private provider body",
      credentials: "synthetic credential",
      prompt: "private reviewer prompt",
    }))
    attempts.push({
      model: "raw provider body: synthetic credential",
      modelIndex: 0,
      attempt: 1,
      requestSent: true,
      outcome: "network-error",
      durationMs: 3,
      error: "private provider body",
    })
    await writer(
      record({
        reviewerModel: model,
        responseModel,
        decisionAttempts: attempts as unknown as NonNullable<ReviewAuditRecord["decisionAttempts"]>,
      }),
    )

    const serialized = await readFile(auditPath, "utf8")
    const written = JSON.parse(serialized.trim()) as Record<string, unknown>
    expect(serialized).not.toContain("private provider body")
    expect(serialized).not.toContain("synthetic credential")
    expect(serialized).not.toContain("private reviewer prompt")
    expect(written.reviewerModel).toBe(model)
    expect(written.responseModel).toBe(responseModel)
    expect(written.decisionAttempts).toHaveLength(40)
    const firstAttempt = (written.decisionAttempts as Array<Record<string, unknown>>)[0]!
    expect(firstAttempt).toEqual({
      model,
      modelIndex: 0,
      attempt: 1,
      requestSent: true,
      outcome: "valid-decision",
      durationMs: 12,
      responseModel,
    })
    expect(Object.keys(firstAttempt).sort()).toEqual(
      [
        "model",
        "modelIndex",
        "attempt",
        "requestSent",
        "outcome",
        "durationMs",
        "responseModel",
      ].sort(),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("V2 audit drops malformed attempt records and unverified model attribution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "permission-reviewer-v2-audit-invalid-"))
  const auditPath = join(directory, "audit.jsonl")
  const config: ReviewerConfig = {
    ...DEFAULT_CONFIG,
    auditPath,
    decisionModels: [model],
  }
  try {
    const writer = createAuditWriter(config)!
    await writer(
      record({
        reviewerModel: "private prompt contents",
        responseModel: "credential: synthetic-secret",
        decisionAttempts: [
          {
            model,
            modelIndex: 0,
            attempt: 1,
            requestSent: true,
            outcome: "not-a-closed-outcome",
            durationMs: 10,
            responseModel: "private provider body",
          },
          {
            model,
            modelIndex: 0,
            attempt: 6,
            requestSent: true,
            outcome: "network-error",
            durationMs: 10,
          },
          {
            model: "raw provider body: synthetic credential",
            modelIndex: 0,
            attempt: 2,
            requestSent: true,
            outcome: "network-error",
            durationMs: 10,
          },
          {
            model,
            modelIndex: 0,
            attempt: 2,
            requestSent: true,
            outcome: "valid-decision",
            durationMs: 10,
            responseModel: "private provider body",
          },
        ] as unknown as NonNullable<ReviewAuditRecord["decisionAttempts"]>,
      }),
    )

    const serialized = await readFile(auditPath, "utf8")
    const written = JSON.parse(serialized.trim()) as Record<string, unknown>
    expect(serialized).not.toContain("private prompt contents")
    expect(serialized).not.toContain("synthetic-secret")
    expect(serialized).not.toContain("private provider body")
    expect(written.reviewerModel).toBeUndefined()
    expect(written.responseModel).toBeUndefined()
    expect(written.decisionAttempts).toEqual([
      {
        model,
        modelIndex: 0,
        attempt: 2,
        requestSent: true,
        outcome: "valid-decision",
        durationMs: 10,
      },
    ])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("V2 audit preserves a closed internal-error outcome without provider details", async () => {
  const directory = await mkdtemp(join(tmpdir(), "permission-reviewer-v2-audit-internal-"))
  const auditPath = join(directory, "audit.jsonl")
  try {
    const writer = createAuditWriter({ ...DEFAULT_CONFIG, auditPath, decisionModels: [model] })!
    await writer(
      record({
        decisionAttempts: [
          {
            model,
            modelIndex: 0,
            attempt: 1,
            requestSent: false,
            outcome: "internal-error",
            durationMs: 4,
            error: "private provider body and credential",
          },
        ] as unknown as NonNullable<ReviewAuditRecord["decisionAttempts"]>,
      }),
    )
    const serialized = await readFile(auditPath, "utf8")
    const written = JSON.parse(serialized.trim()) as Record<string, unknown>
    expect(serialized).not.toContain("private provider body")
    expect(serialized).not.toContain("credential")
    expect(written.decisionAttempts).toEqual([
      {
        model,
        modelIndex: 0,
        attempt: 1,
        requestSent: false,
        outcome: "internal-error",
        durationMs: 4,
      },
    ])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("V2 audit records bounded configured reasoning provenance without copying extras", async () => {
  const directory = await mkdtemp(join(tmpdir(), "permission-reviewer-v2-audit-reasoning-"))
  const auditPath = join(directory, "audit.jsonl")
  const reasoningModel = "openai/gpt-6-luna"
  const credential = `ghp_${"synthetic0123456789abcdefghijklmnopqrstuvwxyz"}`
  try {
    const writer = createAuditWriter({
      ...DEFAULT_CONFIG,
      auditPath,
      decisionModels: [model],
      reasoningModels: [
        {
          model: reasoningModel,
          variant: "medium",
          outputFormat: "json_schema",
          timeoutMs: 120_000,
        },
      ],
    })!
    await writer(
      record({
        reviewerModel: reasoningModel,
        reviewerEscalatedFrom: {
          model,
          reason: `because ${credential}\n${"detail ".repeat(500)}`,
          privatePrompt: "do not serialize",
        } as unknown as NonNullable<ReviewAuditRecord["reviewerEscalatedFrom"]>,
        responseModel,
        decisionAttempts: [
          {
            model,
            modelIndex: 0,
            attempt: 1,
            requestSent: true,
            outcome: "valid-decision",
            durationMs: 12,
            responseModel,
            rawError: "do not serialize",
          },
        ] as unknown as NonNullable<ReviewAuditRecord["decisionAttempts"]>,
      }),
    )
    const serialized = await readFile(auditPath, "utf8")
    const written = JSON.parse(serialized.trim()) as Record<string, unknown>
    const provenance = written.reviewerEscalatedFrom as Record<string, unknown>
    expect(written.reviewerModel).toBe(reasoningModel)
    expect(written.responseModel).toBe(responseModel)
    expect(provenance).toMatchObject({ model })
    expect(Object.keys(provenance).sort()).toEqual(["model", "reason"])
    expect(String(provenance.reason).length).toBeLessThanOrEqual(2_001)
    expect(serialized).not.toContain(credential)
    expect(serialized).not.toContain("privatePrompt")
    expect(serialized).not.toContain("rawError")
    expect(serialized).toContain("[REDACTED")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("V2 audit requires reviewer escalation provenance from a selected configured primary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "permission-reviewer-v2-audit-provenance-"))
  const auditPath = join(directory, "audit.jsonl")
  try {
    const reasoningModel = "openai/gpt-6-luna"
    const writer = createAuditWriter({
      ...DEFAULT_CONFIG,
      auditPath,
      decisionModels: [model],
      reasoningModels: [
        {
          model: reasoningModel,
          variant: "medium",
          outputFormat: "json_schema",
          timeoutMs: 120_000,
        },
      ],
    })!
    await writer(
      record({
        reviewerModel: "openai/gpt-6-luna",
        reviewerEscalatedFrom: {
          model: "openrouter/unconfigured/primary",
          reason: "unconfigured route",
        },
        decisionAttempts: [
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
      }),
    )
    const written = JSON.parse((await readFile(auditPath, "utf8")).trim()) as Record<
      string,
      unknown
    >
    expect(written.reviewerEscalatedFrom).toBeUndefined()
    await writer(
      record({
        reviewerModel: reasoningModel,
        reviewerEscalatedFrom: { model, reason: "route was not selected" },
        decisionAttempts: [
          {
            model,
            modelIndex: 0,
            attempt: 1,
            requestSent: true,
            outcome: "network-error",
            durationMs: 12,
          },
        ],
      }),
    )
    const unselected = JSON.parse(
      (await readFile(auditPath, "utf8")).trim().split("\n")[1]!,
    ) as Record<string, unknown>
    expect(unselected.reviewerModel).toBeUndefined()
    expect(unselected.reviewerEscalatedFrom).toBeUndefined()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("V2 audit requires selected-primary and successful-reasoning evidence for attribution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "permission-reviewer-v2-audit-no-reasoner-proof-"))
  const auditPath = join(directory, "audit.jsonl")
  const reasoningModel = "openai/gpt-6-luna"
  try {
    const writer = createAuditWriter({
      ...DEFAULT_CONFIG,
      auditPath,
      decisionModels: [model],
      reasoningModels: [
        {
          model: reasoningModel,
          variant: "medium",
          outputFormat: "json_schema",
          timeoutMs: 120_000,
        },
      ],
    })!
    await writer(
      record({
        reviewerModel: reasoningModel,
        responseModel,
        decisionAttempts: [
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
      }),
    )
    const written = JSON.parse((await readFile(auditPath, "utf8")).trim()) as Record<
      string,
      unknown
    >
    expect(written.reviewerModel).toBeUndefined()
    expect(written.reviewerEscalatedFrom).toBeUndefined()
    expect(written.responseModel).toBe(responseModel)
    await writer(record({ reviewerModel: model }))
    const unselectedPrimary = JSON.parse(
      (await readFile(auditPath, "utf8")).trim().split("\n")[1]!,
    ) as Record<string, unknown>
    expect(unselectedPrimary.reviewerModel).toBeUndefined()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("V2 audit attributes reasoning escalation only to the active first configured reasoning model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "permission-reviewer-v2-audit-active-reasoning-"))
  const auditPath = join(directory, "audit.jsonl")
  const activeReasoningModel = "openai/gpt-6-luna"
  const inactiveReasoningModel = "openai/gpt-6-rhea"
  const attempts = [
    {
      model,
      modelIndex: 0,
      attempt: 1,
      requestSent: true,
      outcome: "valid-decision",
      durationMs: 12,
      responseModel,
    },
  ] as unknown as NonNullable<ReviewAuditRecord["decisionAttempts"]>
  try {
    const writer = createAuditWriter({
      ...DEFAULT_CONFIG,
      auditPath,
      decisionModels: [model],
      reasoningModels: [
        {
          model: activeReasoningModel,
          variant: "medium",
          outputFormat: "json_schema",
          timeoutMs: 120_000,
        },
        {
          model: inactiveReasoningModel,
          variant: "medium",
          outputFormat: "json_schema",
          timeoutMs: 120_000,
        },
      ],
    })!
    await writer(
      record({
        reviewerModel: inactiveReasoningModel,
        reviewerEscalatedFrom: { model, reason: "inactive reasoning route" },
        decisionAttempts: attempts,
      }),
    )
    await writer(
      record({
        reviewerModel: activeReasoningModel,
        reviewerEscalatedFrom: { model, reason: "active reasoning route" },
        decisionAttempts: attempts,
      }),
    )
    const lines = (await readFile(auditPath, "utf8")).trim().split("\n")
    const inactive = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(inactive.reviewerModel).toBeUndefined()
    expect(inactive.reviewerEscalatedFrom).toBeUndefined()
    const active = JSON.parse(lines[1]!) as Record<string, unknown>
    expect(active.reviewerModel).toBe(activeReasoningModel)
    expect(active.reviewerEscalatedFrom).toMatchObject({ model })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("V2 audit keeps primary attribution when no reasoning model is configured", async () => {
  const directory = await mkdtemp(join(tmpdir(), "permission-reviewer-v2-audit-no-reasoning-"))
  const auditPath = join(directory, "audit.jsonl")
  const attempts = [
    {
      model,
      modelIndex: 0,
      attempt: 1,
      requestSent: true,
      outcome: "valid-decision",
      durationMs: 12,
      responseModel,
    },
  ] as unknown as NonNullable<ReviewAuditRecord["decisionAttempts"]>
  try {
    const writer = createAuditWriter({
      ...DEFAULT_CONFIG,
      auditPath,
      decisionModels: [model],
      reasoningModels: [],
    })!
    await writer(record({ reviewerModel: model, decisionAttempts: attempts }))
    await writer(
      record({
        reviewerModel: "openai/gpt-6-luna",
        reviewerEscalatedFrom: { model, reason: "unconfigured reasoning route" },
        decisionAttempts: attempts,
      }),
    )
    const lines = (await readFile(auditPath, "utf8")).trim().split("\n")
    const primary = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(primary.reviewerModel).toBe(model)
    const unconfigured = JSON.parse(lines[1]!) as Record<string, unknown>
    expect(unconfigured.reviewerModel).toBeUndefined()
    expect(unconfigured.reviewerEscalatedFrom).toBeUndefined()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("V2 audit keeps primary attribution for a model also listed as inactive reasoning", async () => {
  const directory = await mkdtemp(join(tmpdir(), "permission-reviewer-v2-audit-overlap-"))
  const auditPath = join(directory, "audit.jsonl")
  const attempts = [
    {
      model,
      modelIndex: 0,
      attempt: 1,
      requestSent: true,
      outcome: "valid-decision",
      durationMs: 12,
      responseModel,
    },
  ] as unknown as NonNullable<ReviewAuditRecord["decisionAttempts"]>
  try {
    const writer = createAuditWriter({
      ...DEFAULT_CONFIG,
      auditPath,
      decisionModels: [model],
      reasoningModels: [
        {
          model: "openai/gpt-6-luna",
          variant: "medium",
          outputFormat: "json_schema",
          timeoutMs: 120_000,
        },
        {
          // Same string doubles as an inactive reasoning entry; the primary
          // Decisions branch must still attribute it as the selected route.
          model,
          variant: "medium",
          outputFormat: "json_schema",
          timeoutMs: 120_000,
        },
      ],
    })!
    await writer(record({ reviewerModel: model, decisionAttempts: attempts }))
    const persisted = JSON.parse(
      (await readFile(auditPath, "utf8")).trim().split("\n")[0]!,
    ) as Record<string, unknown>
    expect(persisted.reviewerModel).toBe(model)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("V2 audit accepts the exact maximum native response identity lengths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "permission-reviewer-v2-audit-lengths-"))
  const auditPath = join(directory, "audit.jsonl")
  const publisher = "p".repeat(64)
  const nativeModel = "m".repeat(128)
  const selected = `openrouter/${publisher}/${nativeModel}`
  const nativeBase = `${publisher}/${nativeModel}`
  const dated = `${nativeBase}-20261013`
  const oversized = `${nativeBase}-202610130`
  expect(selected.length).toBe(204)
  expect(nativeBase.length).toBe(193)
  expect(dated.length).toBe(202)
  expect(oversized.length).toBe(203)
  expect(isValidDecisionsModel(selected)).toBe(true)
  try {
    const writer = createAuditWriter({
      ...DEFAULT_CONFIG,
      auditPath,
      decisionModels: [selected],
    })!
    await writer(
      record({
        reviewerModel: selected,
        responseModel: dated,
        decisionAttempts: [nativeBase, dated, oversized].map((identity) => ({
          model: selected,
          modelIndex: 0,
          attempt: 1,
          requestSent: true,
          outcome: "valid-decision",
          durationMs: 1,
          responseModel: identity,
        })) as unknown as NonNullable<ReviewAuditRecord["decisionAttempts"]>,
      }),
    )
    const written = JSON.parse((await readFile(auditPath, "utf8")).trim()) as Record<
      string,
      unknown
    >
    const attempts = written.decisionAttempts as Array<Record<string, unknown>>
    expect(attempts.map((attempt) => attempt.responseModel)).toEqual([nativeBase, dated, undefined])
    expect(written.responseModel).toBe(dated)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("V2 default Free-only config cannot use legacy fallback metadata to attribute paid Jev", async () => {
  const directory = await mkdtemp(join(tmpdir(), "permission-reviewer-v2-audit-legacy-fallback-"))
  const auditPath = join(directory, "audit.jsonl")
  try {
    const writer = createAuditWriter({
      ...DEFAULT_CONFIG,
      auditPath,
      decisionModels: ["opencode/jev-1.13-free"],
    })!
    await writer(
      record({
        reviewerModel: "openrouter/typesafe/jev-1.13",
        fallbackFrom: "opencode/jev-1.13-free",
        fallbackReason: "rate-limited",
        fallbackAttempts: 3,
      }),
    )
    const written = JSON.parse((await readFile(auditPath, "utf8")).trim()) as Record<
      string,
      unknown
    >
    expect(written.reviewerModel).toBeUndefined()
    expect(written.fallbackFrom).toBe("opencode/jev-1.13-free")
    expect(written.fallbackReason).toBe("rate-limited")
    expect(written.fallbackAttempts).toBe(3)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("V1 records without Decisions metadata retain their existing audit shape", async () => {
  const directory = await mkdtemp(join(tmpdir(), "permission-reviewer-v1-audit-shape-"))
  const auditPath = join(directory, "audit.jsonl")
  try {
    const writer = createAuditWriter({ ...DEFAULT_CONFIG, auditPath })!
    await writer(
      record({
        reviewerModel: "openrouter/typesafe/jev-1.13",
        reviewerEscalatedFrom: {
          model: "opencode/jev-1.13-free",
          reason: "legacy V1 escalation",
        },
        fallbackFrom: "opencode/jev-1.13-free",
        fallbackReason: "rate-limited",
        fallbackAttempts: 3,
      }),
    )
    const written = JSON.parse((await readFile(auditPath, "utf8")).trim()) as Record<
      string,
      unknown
    >
    expect(written.decisionAttempts).toBeUndefined()
    expect(written.responseModel).toBeUndefined()
    expect(written.reviewerModel).toBe("openrouter/typesafe/jev-1.13")
    expect(written.reviewerEscalatedFrom).toEqual({
      model: "opencode/jev-1.13-free",
      reason: "legacy V1 escalation",
    })
    expect(written.fallbackFrom).toBe("opencode/jev-1.13-free")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
