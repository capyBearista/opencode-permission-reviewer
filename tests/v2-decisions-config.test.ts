import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  loadResolvedConfig,
  projectConfigPath,
  setGlobalConfigPathForTests,
} from "../src/config/loader.ts"
import { DEFAULT_CONFIG, reviewBudgetMs } from "../src/config.ts"
import type { EscalationReviewerConfig } from "../src/types.ts"

const DEFAULT_DECISION_MODELS = ["opencode/jev-1.13-free"]
const DEFAULT_REASONING_MODEL: EscalationReviewerConfig = {
  model: "openai/gpt-6-luna",
  variant: "medium",
  outputFormat: "json_schema",
  timeoutMs: 120_000,
}

describe("V2 Decisions configuration", () => {
  const isolatedGlobal = join(tmpdir(), `reviewer-v2-global-absent-${process.pid}.jsonc`)

  beforeAll(() => setGlobalConfigPathForTests(isolatedGlobal))
  afterAll(() => setGlobalConfigPathForTests(undefined))

  test("V2 defaults to the free Decisions route and one Luna reasoning route", () => {
    const config = loadResolvedConfig(undefined, undefined, "trusted", "v2")

    expect(config.decisionModels).toEqual(DEFAULT_DECISION_MODELS)
    expect(config.reasoningModels).toEqual([DEFAULT_REASONING_MODEL])
    expect(config.decisionMaxAttempts).toBe(2)
    expect(config.decisionAttemptTimeoutMs).toBe(10_000)
    expect(config.configDegraded).toBeUndefined()
  })

  test("trusted custom route arrays and bounded attempt controls are retained", () => {
    const config = loadResolvedConfig(
      {
        decisionModels: ["openrouter/anthropic/claude-sonnet-4", "opencode/jev-1.13-free"],
        reasoningModels: [
          { model: "openai/gpt-6-luna", variant: "high", timeoutMs: 30_000 },
          { model: "openrouter/google/gemini-2.5-pro", outputFormat: "text" },
        ],
        decisionMaxAttempts: 5,
        decisionAttemptTimeoutMs: 60_000,
      },
      undefined,
      "trusted",
      "v2",
    )

    expect(config.decisionModels).toEqual([
      "openrouter/anthropic/claude-sonnet-4",
      "opencode/jev-1.13-free",
    ])
    expect(config.reasoningModels).toEqual([
      {
        model: "openai/gpt-6-luna",
        variant: "high",
        outputFormat: "json_schema",
        timeoutMs: 30_000,
      },
      {
        model: "openrouter/google/gemini-2.5-pro",
        variant: "medium",
        outputFormat: "text",
        timeoutMs: 120_000,
      },
    ])
    expect(config.decisionMaxAttempts).toBe(5)
    expect(config.decisionAttemptTimeoutMs).toBe(60_000)
    expect(config.configDegraded).toBeUndefined()
  })

  test("invalid explicit trusted arrays degrade to empty instead of defaulting or filtering", () => {
    const invalidDecisionModels = [
      [],
      Array.from({ length: 9 }, (_, index) => `openrouter/publisher/model-${index}`),
      ["openrouter/publisher/model", "openrouter/publisher/model"],
      ["openrouter/publisher/model", "https://example.test/model"],
      "openrouter/publisher/model",
    ]

    for (const decisionModels of invalidDecisionModels) {
      const config = loadResolvedConfig({ decisionModels }, undefined, "trusted", "v2")
      expect(config.decisionModels).toEqual([])
      expect(config.configDegraded).toContain(
        "inline config decisionModels is invalid and was ignored",
      )
    }

    const invalidReasoningModels = [
      [],
      Array.from({ length: 9 }, (_, index) => ({ model: `provider/model-${index}` })),
      [{ model: "provider/model" }, { model: "provider/model" }],
      [{ model: "openai/gpt-6-luna" }, { model: "https://example.test/model" }],
    ]

    for (const reasoningModels of invalidReasoningModels) {
      const config = loadResolvedConfig({ reasoningModels }, undefined, "trusted", "v2")
      expect(config.reasoningModels).toEqual([])
      expect(config.configDegraded).toContain(
        "inline config reasoningModels is invalid and was ignored",
      )
    }
  })

  test("decision IDs allow generic bounded OpenRouter models but reject URLs and controls", () => {
    const models = [
      "openrouter/anthropic/claude-sonnet-4",
      "openrouter/google/gemini-2.5-pro",
      "openrouter/meta-llama/llama-4-maverick",
      "openrouter/deepseek/deepseek-r1",
      "openrouter/x-ai/grok-3",
      "openrouter/acme/new-model-v9:free",
    ]
    const config = loadResolvedConfig({ decisionModels: models }, undefined, "trusted", "v2")
    expect(config.decisionModels).toEqual(models)
    expect(config.configDegraded).toBeUndefined()

    for (const model of [
      "https://openrouter.ai/acme/model",
      "openrouter/acme/model\nwith-control",
      "openrouter/acme//model",
      "openrouter/acme/model?endpoint=https://evil.test",
      "opencode/jev-1.13",
    ]) {
      const invalid = loadResolvedConfig({ decisionModels: [model] }, undefined, "trusted", "v2")
      expect(invalid.decisionModels).toEqual([])
      expect(invalid.configDegraded).toContain(
        "inline config decisionModels is invalid and was ignored",
      )
    }
  })

  test("all four routing keys are trusted-only across project and unknown inline sources", () => {
    const directory = mkdtempSync(join(tmpdir(), "reviewer-v2-trust-"))
    const projectConfig = {
      decisionModels: ["openrouter/project/model"],
      reasoningModels: [{ model: "project/model" }],
      decisionMaxAttempts: 5,
      decisionAttemptTimeoutMs: 60_000,
    }
    try {
      mkdirSync(join(directory, ".opencode"), { recursive: true })
      writeFileSync(projectConfigPath(directory), JSON.stringify(projectConfig))

      const projectOnly = loadResolvedConfig(undefined, directory, "trusted", "v2")
      expect(projectOnly.decisionModels).toEqual(DEFAULT_DECISION_MODELS)
      expect(projectOnly.reasoningModels).toEqual([DEFAULT_REASONING_MODEL])
      expect(projectOnly.decisionMaxAttempts).toBe(2)
      expect(projectOnly.decisionAttemptTimeoutMs).toBe(10_000)

      const trusted = loadResolvedConfig(projectConfig, directory, "trusted", "v2")
      expect(trusted.decisionModels).toEqual(projectConfig.decisionModels)
      expect(trusted.reasoningModels?.[0]?.model).toBe("project/model")
      expect(trusted.decisionMaxAttempts).toBe(5)
      expect(trusted.decisionAttemptTimeoutMs).toBe(60_000)

      const unknown = loadResolvedConfig(projectConfig, directory, "unknown", "v2")
      expect(unknown.decisionModels).toEqual(DEFAULT_DECISION_MODELS)
      expect(unknown.reasoningModels).toEqual([DEFAULT_REASONING_MODEL])
      expect(unknown.decisionMaxAttempts).toBe(2)
      expect(unknown.decisionAttemptTimeoutMs).toBe(10_000)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("V1 ignores malformed V2 keys and V2 does not migrate obsolete legacy routes", () => {
    const v1 = loadResolvedConfig({
      decisionModels: [],
      reasoningModels: [{ model: "https://invalid.test" }],
      decisionMaxAttempts: 99,
      decisionAttemptTimeoutMs: 0,
    })
    expect(v1.decisionModels).toBeUndefined()
    expect(v1.reasoningModels).toBeUndefined()
    expect(v1.decisionMaxAttempts).toBeUndefined()
    expect(v1.decisionAttemptTimeoutMs).toBeUndefined()
    expect(v1.configDegraded).toBeUndefined()

    const v2 = loadResolvedConfig(
      {
        model: "openrouter/legacy/model",
        systemOneFallback: { model: "openrouter/typesafe/jev-1.13" },
        escalationReviewer: { model: "legacy/reviewer" },
      },
      undefined,
      "trusted",
      "v2",
    )
    expect(v2.decisionModels).toEqual(DEFAULT_DECISION_MODELS)
    expect(v2.reasoningModels).toEqual([DEFAULT_REASONING_MODEL])
    expect(v2.model).toBe(DEFAULT_CONFIG.model)
    expect(v2.systemOneFallback).toBeUndefined()
    expect(v2.escalationReviewer).toBeUndefined()
    expect(v2.configDegraded).toBeUndefined()
  })

  test("invalid trusted resource values degrade and use safe numeric defaults", () => {
    for (const decisionMaxAttempts of [0, 6, 1.5, "3"]) {
      const config = loadResolvedConfig({ decisionMaxAttempts }, undefined, "trusted", "v2")
      expect(config.decisionMaxAttempts).toBe(2)
      expect(config.configDegraded).toContain(
        "inline config decisionMaxAttempts is invalid and was ignored",
      )
    }

    for (const decisionAttemptTimeoutMs of [999, 60_001, 10_000.5, "10000"]) {
      const config = loadResolvedConfig({ decisionAttemptTimeoutMs }, undefined, "trusted", "v2")
      expect(config.decisionAttemptTimeoutMs).toBe(10_000)
      expect(config.configDegraded).toContain(
        "inline config decisionAttemptTimeoutMs is invalid and was ignored",
      )
    }

    const validMinimum = loadResolvedConfig(
      { decisionMaxAttempts: 1, decisionAttemptTimeoutMs: 1_000 },
      undefined,
      "trusted",
      "v2",
    )
    expect(validMinimum.decisionMaxAttempts).toBe(1)
    expect(validMinimum.decisionAttemptTimeoutMs).toBe(1_000)
    const validMaximum = loadResolvedConfig(
      { decisionMaxAttempts: 5, decisionAttemptTimeoutMs: 60_000 },
      undefined,
      "trusted",
      "v2",
    )
    expect(validMaximum.decisionMaxAttempts).toBe(5)
    expect(validMaximum.decisionAttemptTimeoutMs).toBe(60_000)
  })

  test("review budget calculation remains independent of Decisions attempt controls", () => {
    const config = loadResolvedConfig(
      {
        timeoutMs: 120_000,
        decisionMaxAttempts: 5,
        decisionAttemptTimeoutMs: 60_000,
      },
      undefined,
      "trusted",
      "v2",
    )

    expect(reviewBudgetMs(config)).toBe(DEFAULT_CONFIG.timeoutMs * 2 + 60_000)
  })
})
