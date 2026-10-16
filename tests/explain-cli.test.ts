import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { runCli } from "../src/cli/explain.ts"

describe("explain CLI", () => {
  test("native inputs preserve evidence completeness without treating resources as shell commands", async () => {
    for (const input of [
      { action: "shell", resources: ["printf *"] },
      { action: "read", resources: ["file.txt"], input: { path: "file.txt" } },
    ]) {
      const proc = Bun.spawn({
        cmd: ["bun", "run", "src/cli/explain.ts", "--defaults"],
        cwd: import.meta.dir + "/..",
        stdin: new TextEncoder().encode(JSON.stringify(input)),
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(await proc.exited).toBe(0)
      const result = JSON.parse(await new Response(proc.stdout).text())
      expect(result.command).toBe("")
      expect(result.nativeAction).toBe(input.action)
      expect(result.actionEvidenceComplete).toBe(input.action === "read")
    }
  })

  test("parses a bash fixture and prints capability + policyTrace", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "run", "src/cli/explain.ts"],
      cwd: import.meta.dir + "/..",
      stdin: new TextEncoder().encode(
        JSON.stringify({ permission: "bash", metadata: { command: "pip install x" } }),
      ),
      stdout: "pipe",
      stderr: "pipe",
    })
    const exitCode = await proc.exited
    const stdout = await new Response(proc.stdout).text()
    expect(exitCode).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.permission).toBe("bash")
    expect(parsed.capability.actionClass.value).toBe("package-management")
    expect(parsed.policyTrace.mode).toBe("observe")
    expect(parsed.policyTrace.finalRoute).toBe("review")
  })

  test("omitted generation preserves V1 explain config and ignores V2 routing fields", async () => {
    const home = mkdtempSync(join(tmpdir(), "reviewer-explain-v1-"))
    const project = mkdtempSync(join(tmpdir(), "reviewer-explain-project-v1-"))
    const configDirectory = join(home, ".config", "opencode")
    mkdirSync(configDirectory, { recursive: true })
    writeFileSync(
      join(configDirectory, "permission-reviewer.jsonc"),
      JSON.stringify({
        model: "openrouter/acme/v1-diagnostic-model",
        decisionModels: [],
        reasoningModels: [{ model: "https://invalid.example/model" }],
      }),
    )
    try {
      const proc = Bun.spawn({
        cmd: ["bun", "run", "src/cli/explain.ts", "--project", project],
        cwd: import.meta.dir + "/..",
        env: { ...process.env, HOME: home },
        stdin: new TextEncoder().encode(
          JSON.stringify({ permission: "bash", metadata: { command: "printf ok" } }),
        ),
        stdout: "pipe",
        stderr: "pipe",
      })
      const exitCode = await proc.exited
      const stdout = await new Response(proc.stdout).text()
      expect(exitCode).toBe(0)
      const result = JSON.parse(stdout)
      expect(result.model).toBe("openrouter/acme/v1-diagnostic-model")
      expect(result).not.toHaveProperty("decisionModels")
    } finally {
      rmSync(home, { recursive: true })
      rmSync(project, { recursive: true })
    }
  })

  test("V2 explain displays only the first configured Decisions model", async () => {
    const home = mkdtempSync(join(tmpdir(), "reviewer-explain-v2-"))
    const configDirectory = join(home, ".config", "opencode")
    mkdirSync(configDirectory, { recursive: true })
    writeFileSync(
      join(configDirectory, "permission-reviewer.jsonc"),
      JSON.stringify({
        decisionModels: ["openrouter/acme/diagnostic-first", "openrouter/acme/diagnostic-second"],
        reasoningModels: [
          { model: "openrouter/acme/diagnostic-reasoner" },
          { model: "openrouter/acme/unused-reasoner" },
        ],
      }),
    )
    try {
      const proc = Bun.spawn({
        cmd: ["bun", "run", "src/cli/explain.ts", "--generation", "v2"],
        cwd: import.meta.dir + "/..",
        env: { ...process.env, HOME: home },
        stdin: new TextEncoder().encode(
          JSON.stringify({ permission: "bash", metadata: { command: "printf ok" } }),
        ),
        stdout: "pipe",
        stderr: "pipe",
      })
      const exitCode = await proc.exited
      const stdout = await new Response(proc.stdout).text()
      expect(exitCode).toBe(0)
      const result = JSON.parse(stdout)
      expect(result.model).toBe("openrouter/acme/diagnostic-first")
      expect(result.model).not.toBe("openai/gpt-6-luna")
      expect(result).not.toHaveProperty("decisionModels")
      expect(result).not.toHaveProperty("reasoningModels")
    } finally {
      rmSync(home, { recursive: true })
    }
  })

  test("V2 explain reports malformed trusted routing arrays as degraded and empty", async () => {
    const home = mkdtempSync(join(tmpdir(), "reviewer-explain-v2-invalid-"))
    const configDirectory = join(home, ".config", "opencode")
    mkdirSync(configDirectory, { recursive: true })
    writeFileSync(
      join(configDirectory, "permission-reviewer.jsonc"),
      JSON.stringify({
        decisionModels: [],
        reasoningModels: [{ model: "https://invalid.example/model" }],
      }),
    )
    try {
      const proc = Bun.spawn({
        cmd: ["bun", "run", "src/cli/explain.ts", "--generation", "v2"],
        cwd: import.meta.dir + "/..",
        env: { ...process.env, HOME: home },
        stdin: new TextEncoder().encode(
          JSON.stringify({ permission: "bash", metadata: { command: "printf ok" } }),
        ),
        stdout: "pipe",
        stderr: "pipe",
      })
      const exitCode = await proc.exited
      const stdout = await new Response(proc.stdout).text()
      expect(exitCode).toBe(0)
      const result = JSON.parse(stdout)
      expect(result.model).toBeNull()
      expect(result.configDegraded).toContain(
        "global config decisionModels is invalid and was ignored",
      )
      expect(result.configDegraded).toContain(
        "global config reasoningModels is invalid and was ignored",
      )
    } finally {
      rmSync(home, { recursive: true })
    }
  })

  test("V2 defaults are diagnostic only and make no fetch calls", async () => {
    const directory = mkdtempSync(join(tmpdir(), "reviewer-explain-v2-defaults-"))
    const event = join(directory, "event.json")
    writeFileSync(event, JSON.stringify({ permission: "bash", metadata: { command: "printf ok" } }))
    const originalFetch = globalThis.fetch
    const originalLog = console.log
    let fetchCalls = 0
    let output = ""
    globalThis.fetch = Object.assign(
      async () => {
        fetchCalls += 1
        throw new Error("explain diagnostics must not make network requests")
      },
      { preconnect: originalFetch.preconnect.bind(originalFetch) },
    )
    console.log = (...args: unknown[]) => {
      output += `${args.join(" ")}\n`
    }
    try {
      const exitCode = await runCli([
        "explain",
        "--generation",
        "v2",
        "--defaults",
        "--event",
        event,
      ])
      expect(exitCode).toBe(0)
      expect(fetchCalls).toBe(0)
      expect(JSON.parse(output).model).toBe("opencode/jev-1.13-free")
    } finally {
      globalThis.fetch = originalFetch
      console.log = originalLog
      rmSync(directory, { recursive: true })
    }
  })

  test("rejects unsupported explain generations", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "run", "src/cli/explain.ts", "--generation", "automatic"],
      cwd: import.meta.dir + "/..",
      stdin: new TextEncoder().encode("{}"),
      stdout: "pipe",
      stderr: "pipe",
    })
    const exitCode = await proc.exited
    const stderr = await new Response(proc.stderr).text()
    expect(exitCode).toBe(2)
    expect(stderr).toContain('--generation must be "v1" or "v2"')
  })

  test("exits 2 on invalid JSON", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "run", "src/cli/explain.ts"],
      cwd: import.meta.dir + "/..",
      stdin: new TextEncoder().encode("not json"),
      stdout: "pipe",
      stderr: "pipe",
    })
    const exitCode = await proc.exited
    expect(exitCode).toBe(2)
  })

  test("exits 2 on missing permission field", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "run", "src/cli/explain.ts"],
      cwd: import.meta.dir + "/..",
      stdin: new TextEncoder().encode(JSON.stringify({ foo: "bar" })),
      stdout: "pipe",
      stderr: "pipe",
    })
    const exitCode = await proc.exited
    expect(exitCode).toBe(2)
  })

  test("non-bash permission yields null capability", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "run", "src/cli/explain.ts"],
      cwd: import.meta.dir + "/..",
      stdin: new TextEncoder().encode(
        JSON.stringify({ permission: "edit", patterns: ["file.txt"] }),
      ),
      stdout: "pipe",
      stderr: "pipe",
    })
    const exitCode = await proc.exited
    const stdout = await new Response(proc.stdout).text()
    expect(exitCode).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.capability).toBeNull()
  })
})
