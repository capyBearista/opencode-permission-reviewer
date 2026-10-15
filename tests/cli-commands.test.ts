import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const CWD = import.meta.dir + "/.."

function run(
  args: string[],
  env?: Record<string, string>,
): Promise<{
  exitCode: number
  stdout: string
  stderr: string
}> {
  const proc = Bun.spawn({
    cmd: ["bun", "run", "src/cli/explain.ts", ...args],
    cwd: CWD,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  })
  return Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).then(([exitCode, stdout, stderr]) => ({ exitCode, stdout, stderr }))
}

function writeGlobalConfig(home: string, config: Record<string, unknown>): void {
  const directory = join(home, ".config", "opencode")
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, "permission-reviewer.jsonc"), JSON.stringify(config))
}

function writeProjectConfig(project: string, config: Record<string, unknown>): void {
  const directory = join(project, ".opencode")
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, "permission-reviewer.jsonc"), JSON.stringify(config))
}

describe("doctor", () => {
  test("reports versions, config sources, and audit writability offline", async () => {
    const home = mkdtempSync(join(tmpdir(), "reviewer-doc-"))
    try {
      const { exitCode, stderr } = await run(["doctor"], { HOME: home })
      expect(exitCode).toBe(0)
      expect(stderr).toContain("opencode")
      expect(stderr).toContain("model:")
      expect(stderr).toContain("mode:       observe")
      expect(stderr).toContain("declarative rules audited only")
      expect(stderr).toContain("reviewer auto-allow/deny remains active")
      expect(stderr).toContain("writable:   yes")
    } finally {
      rmSync(home, { recursive: true })
    }
  }, 15_000)

  test("--json emits valid JSON", async () => {
    const home = mkdtempSync(join(tmpdir(), "reviewer-doc-"))
    try {
      const { exitCode, stdout } = await run(["doctor", "--json"], { HOME: home })
      expect(exitCode).toBe(0)
      const report = JSON.parse(stdout)
      expect(report.version.package).toBeTruthy()
      expect(report.config.model).toBe("openai/gpt-6-luna")
      expect(report.config).not.toHaveProperty("generation")
      expect(report.config).not.toHaveProperty("decisionModels")
      expect(report.config.enforcementMode).toBe("observe")
    } finally {
      rmSync(home, { recursive: true })
    }
  }, 15_000)

  test("V2 diagnostics report trusted ordered routes and only the first reasoning model", async () => {
    const home = mkdtempSync(join(tmpdir(), "reviewer-doc-v2-"))
    const project = mkdtempSync(join(tmpdir(), "reviewer-project-v2-"))
    const decisionModels = ["openrouter/acme/first-model", "openrouter/acme/second-model"]
    const reasoningModels = [
      {
        model: "openrouter/acme/first-reasoner",
        variant: "high",
        outputFormat: "text",
        timeoutMs: 30_000,
      },
      { model: "openrouter/acme/second-reasoner" },
    ]
    try {
      writeGlobalConfig(home, {
        decisionModels,
        reasoningModels,
        decisionMaxAttempts: 4,
        decisionAttemptTimeoutMs: 25_000,
      })
      writeProjectConfig(project, {
        decisionModels: ["openrouter/project/ignored-model"],
        reasoningModels: [{ model: "project/ignored-reasoner" }],
        decisionMaxAttempts: 5,
        decisionAttemptTimeoutMs: 60_000,
      })

      const jsonResult = await run(
        ["doctor", "--generation", "v2", "--project", project, "--json"],
        { HOME: home },
      )
      expect(jsonResult.exitCode).toBe(0)
      const config = JSON.parse(jsonResult.stdout).config
      expect(config.generation).toBe("v2")
      expect(config.decisionModels).toEqual(decisionModels)
      expect(config.reasoningModel).toEqual({
        model: "openrouter/acme/first-reasoner",
        variant: "high",
        outputFormat: "text",
        timeoutMs: 30_000,
      })
      expect(config).not.toHaveProperty("reasoningModels")
      expect(config).not.toHaveProperty("model")
      expect(config.decisionMaxAttempts).toBe(4)
      expect(config.decisionAttemptTimeoutMs).toBe(25_000)
      expect(config.configDegraded).toEqual([])

      const humanResult = await run(["doctor", "--generation", "v2", "--project", project], {
        HOME: home,
      })
      expect(humanResult.exitCode).toBe(0)
      expect(humanResult.stderr).toContain("generation:  v2")
      expect(humanResult.stderr).toContain(
        "decision models: openrouter/acme/first-model -> openrouter/acme/second-model",
      )
      expect(humanResult.stderr).toContain("reasoning model: openrouter/acme/first-reasoner")
      expect(humanResult.stderr).not.toContain("second-reasoner")
      expect(humanResult.stderr).not.toContain("model:      openai/gpt-6-luna")
      expect(humanResult.stderr).toContain("decision max attempts: 4")
      expect(humanResult.stderr).toContain("decision attempt timeout: 25000ms")

      const effectiveResult = await run(
        ["config", "print-effective", "--generation", "v2", "--project", project],
        { HOME: home },
      )
      expect(effectiveResult.exitCode).toBe(0)
      const effective = JSON.parse(effectiveResult.stdout).config
      expect(effective.decisionModels).toEqual(decisionModels)
      expect(effective.reasoningModels).toHaveLength(2)
      expect(effective.decisionMaxAttempts).toBe(4)
      expect(effective.decisionAttemptTimeoutMs).toBe(25_000)
    } finally {
      rmSync(home, { recursive: true })
      rmSync(project, { recursive: true })
    }
  }, 20_000)

  test("V2 print-effective retains defaults and ignores project routing values", async () => {
    const home = mkdtempSync(join(tmpdir(), "reviewer-cfg-v2-"))
    const project = mkdtempSync(join(tmpdir(), "reviewer-project-v2-"))
    try {
      writeProjectConfig(project, {
        decisionModels: ["openrouter/project/ignored-model"],
        reasoningModels: [{ model: "project/ignored-reasoner" }],
        decisionMaxAttempts: 5,
        decisionAttemptTimeoutMs: 60_000,
      })
      const { exitCode, stdout } = await run(
        ["config", "print-effective", "--generation", "v2", "--project", project],
        { HOME: home },
      )
      expect(exitCode).toBe(0)
      const config = JSON.parse(stdout).config
      expect(config.decisionModels).toEqual(["opencode/jev-1.13-free"])
      expect(config.reasoningModels).toEqual([
        {
          model: "openai/gpt-6-luna",
          variant: "medium",
          outputFormat: "json_schema",
          timeoutMs: 120_000,
        },
      ])
      expect(config.decisionMaxAttempts).toBe(2)
      expect(config.decisionAttemptTimeoutMs).toBe(10_000)
    } finally {
      rmSync(home, { recursive: true })
      rmSync(project, { recursive: true })
    }
  }, 15_000)

  test("doctor reports malformed trusted V2 routing arrays as degraded and empty", async () => {
    const home = mkdtempSync(join(tmpdir(), "reviewer-doc-v2-invalid-"))
    try {
      writeGlobalConfig(home, {
        decisionModels: [],
        reasoningModels: [{ model: "https://invalid.example/model" }],
      })
      const { exitCode, stdout } = await run(["doctor", "--generation", "v2", "--json"], {
        HOME: home,
      })
      expect(exitCode).toBe(0)
      const config = JSON.parse(stdout).config
      expect(config.generation).toBe("v2")
      expect(config.decisionModels).toEqual([])
      expect(config.reasoningModel).toBeNull()
      expect(config.decisionMaxAttempts).toBe(2)
      expect(config.decisionAttemptTimeoutMs).toBe(10_000)
      expect(config.configDegraded).toContain(
        "global config decisionModels is invalid and was ignored",
      )
      expect(config.configDegraded).toContain(
        "global config reasoningModels is invalid and was ignored",
      )
    } finally {
      rmSync(home, { recursive: true })
    }
  }, 15_000)

  test("rejects unsupported generations for doctor and print-effective", async () => {
    for (const args of [
      ["doctor", "--generation", "automatic"],
      ["config", "print-effective", "--generation", "automatic"],
    ]) {
      const { exitCode, stderr } = await run(args)
      expect(exitCode).toBe(2)
      expect(stderr).toContain('--generation must be "v1" or "v2"')
    }
  }, 15_000)

  test("rejects an unknown flag with exit 2", async () => {
    const { exitCode } = await run(["doctor", "--bogus"])
    expect(exitCode).toBe(2)
  }, 10_000)
})

describe("config print-effective", () => {
  test("prints the resolved config and effective policy hash", async () => {
    const home = mkdtempSync(join(tmpdir(), "reviewer-cfg-"))
    try {
      const { exitCode, stdout } = await run(["config", "print-effective"], { HOME: home })
      expect(exitCode).toBe(0)
      const report = JSON.parse(stdout)
      expect(report.command).toBe("print-effective")
      expect(report.config.model).toBe("openai/gpt-6-luna")
      expect(report.config).not.toHaveProperty("generation")
      expect(report.config).not.toHaveProperty("decisionModels")
      expect(report.config).not.toHaveProperty("reasoningModels")
      expect(report.policy.ruleCount).toBe(0)
      expect(report.policy.effectivePolicyHash).toMatch(/^[0-9a-f]{16}$/)
    } finally {
      rmSync(home, { recursive: true })
    }
  }, 15_000)

  test("requires the print-effective subcommand", async () => {
    const { exitCode } = await run(["config"])
    expect(exitCode).toBe(2)
  }, 10_000)
})

describe("audit report", () => {
  test("summarizes a fixture JSONL file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewer-aud-"))
    try {
      const file = join(dir, "audit.jsonl")
      const v2 = (overrides: Record<string, unknown>) =>
        JSON.stringify({ schemaVersion: 2, timestamp: "2026-01-01T00:00:00.000Z", ...overrides })
      writeFileSync(
        file,
        [
          v2({
            requestID: "r1",
            sessionID: "s1",
            permission: "bash",
            outcome: "allow",
            reason: "ok",
            decisionSource: "llm-reviewer",
            riskLevel: "low",
          }),
          v2({
            requestID: "r2",
            sessionID: "s1",
            permission: "bash",
            outcome: "deny",
            reason: "no",
            decisionSource: "emergency-brake",
            riskLevel: "critical",
          }),
          "{not valid json}",
        ].join("\n") + "\n",
      )
      const { exitCode, stdout } = await run(["audit", "report", "--path", file, "--json"])
      expect(exitCode).toBe(0)
      const summary = JSON.parse(stdout)
      expect(summary.exists).toBe(true)
      expect(summary.validRecords).toBe(2)
      expect(summary.invalidLines).toBe(1)
      expect(summary.byDecisionSource).toEqual({ "llm-reviewer": 1, "emergency-brake": 1 })
      expect(summary.byOutcome).toEqual({ allow: 1, deny: 1 })
    } finally {
      rmSync(dir, { recursive: true })
    }
  }, 15_000)

  test("exit 1 when the audit file is missing", async () => {
    const { exitCode, stderr } = await run(["audit", "report", "--path", "/no/such/file.jsonl"])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("no such file")
  }, 10_000)
})
