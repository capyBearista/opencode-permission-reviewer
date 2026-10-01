import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, stat, writeFile as write } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { V1ReviewerBackend } from "../src/opencode/v1/reviewer-backend.ts"
import { ReviewAttempt } from "../src/core/review-attempt.ts"
import type { ReviewEnvelope, ReviewerConfig } from "../src/types.ts"
import type { RuntimeContext } from "../src/opencode/types.ts"
import { config, request } from "./helpers.ts"

/** A V1 fixture mirroring `v2-backend.test.ts`: the client exposes only the V1
 *  surface (session/tool/mcp.status) and the backend runs against a scratch
 *  isolation base so the real HOME is never touched. */
function fixture(
  options: {
    format?: ReviewerConfig["outputFormat"]
    mcpServers?: boolean | "after-first"
    mcpError?: boolean
    withoutMcp?: boolean
    base?: string
  } = {},
) {
  const base =
    options.base ??
    join(import.meta.dir, ".tmp-reviewer-isolated-v1", String(Math.random()).slice(2))
  const directories: string[] = []
  let sessionID = ""
  const sessionIDs: string[] = []
  let prompts = 0
  let mcpStatuses = 0
  let directoriesRead = 0
  const removed = new Set<string>()

  const client = {
    session: {
      create: async (input: { query?: { directory?: string } }) => {
        const directory = input.query?.directory ?? ""
        directories.push(directory)
        directoriesRead++
        sessionID = `ses_review_${directoriesRead}`
        sessionIDs.push(sessionID)
        return { data: { id: sessionID } }
      },
      messages: async () => ({ data: [] }),
      prompt: async () => {
        prompts++
        return {
          data:
            (options.format ?? "json_schema") === "text"
              ? { info: {}, parts: [{ type: "text", text: JSON.stringify(decision("allow")) }] }
              : { info: { structured: decision("allow") } },
        }
      },
      delete: async ({ path }: { path: { id: string } }) => {
        removed.add(path.id)
        return { data: true }
      },
    },
    tool: { ids: async () => ({ data: ["bash", "read", "write", "webfetch", "task"] }) },
    mcp: options.withoutMcp
      ? undefined
      : {
          status: async () => {
            mcpStatuses++
            if (options.mcpError) return { error: { message: "mcp status unavailable" } }
            return {
              data:
                options.mcpServers === true ||
                (options.mcpServers === "after-first" && mcpStatuses > 1)
                  ? { fixture: { status: "connected" } }
                  : {},
            }
          },
        },
  } as unknown as RuntimeContext["client"]

  const ctx: RuntimeContext = {
    client,
    directory: "/workspace/operational",
    worktree: "/workspace/operational",
    reviewerDirectoryBase: base,
    capabilities: {
      publicPermissionReply: false,
      permissionReplyMessage: false,
      rawAuthenticatedTransport: true,
      sessionGet: true,
      sessionParentID: true,
      assistantAgentMetadata: false,
      assistantModeMetadata: false,
      effectivePermissions: false,
      tuiPublish: false,
    },
  } as RuntimeContext

  const backend = new V1ReviewerBackend(
    ctx,
    config({ model: "fixture/reviewer", outputFormat: options.format ?? "json_schema" }),
    () => {},
    () => {},
  )
  const envelope: ReviewEnvelope = {
    request: request(),
    directory: "/workspace/operational",
    worktree: "/workspace/operational",
    transcript: "Run printf safe",
    intentHistory: "Run printf safe",
    enrichment: "",
    sshAudit: [],
  }
  return {
    backend,
    client,
    base,
    run: async () => {
      const attempt = new ReviewAttempt("generation_fixture", 5000)
      try {
        return await backend.review(envelope, attempt)
      } finally {
        attempt.close("cancelled")
      }
    },
    state: () => ({ directories, sessionIDs, prompts, mcpStatuses, removed }),
    cleanup: async () => {
      await backend.waitForIdle()
      if (existsSync(base)) await rm(base, { recursive: true, force: true })
    },
  }
}

function decision(outcome: "allow" | "deny" | "escalate") {
  return {
    version: 2,
    outcome,
    risk_level: "low",
    user_authorization: "high",
    scope_alignment: "aligned",
    evidence_completeness: "sufficient",
    rationale: "The action is narrow, reversible, and explicitly requested.",
    confidence: 0.95,
  }
}

test("the isolated location is created with config that excludes MCP", async () => {
  const harness = fixture()
  try {
    expect((await harness.run()).kind).toBe("allow")
    const configText = await readFile(join(harness.base, "opencode.json"), "utf8")
    const isolated = JSON.parse(configText) as { plugin: string[] }
    expect(isolated.plugin).toEqual(["./reviewer-isolation.js"])
    const bootstrap = await readFile(join(harness.base, "reviewer-isolation.js"), "utf8")
    expect(bootstrap).toContain("cfg.mcp")
    const configMode = (await stat(join(harness.base, "opencode.json"))).mode & 0o777
    expect(configMode).toBe(0o600)
    const bootstrapMode = (await stat(join(harness.base, "reviewer-isolation.js"))).mode & 0o777
    expect(bootstrapMode).toBe(0o600)
  } finally {
    await harness.cleanup()
  }
})

test("two concurrent first reviews set up the isolated location exactly once", async () => {
  const harness = fixture()
  // Count calls to the private setup writer: without an in-flight guard the two
  // concurrent first reviews each run setup, producing four writes (two per
  // file) instead of two and letting the second O_TRUNC empty the config the
  // host has already cached.
  let writes = 0
  const setup = harness.backend as unknown as {
    writeIsolatedFile: (path: string, content: string) => Promise<void>
  }
  const writeIsolatedFile = setup.writeIsolatedFile.bind(harness.backend)
  setup.writeIsolatedFile = async (path, content) => {
    writes++
    await writeIsolatedFile(path, content)
  }
  try {
    const [first, second] = await Promise.all([harness.run(), harness.run()])
    expect(first.kind).toBe("allow")
    expect(second.kind).toBe("allow")
    expect(writes).toBe(2)
    const configPath = join(harness.base, "opencode.json")
    const isolated = JSON.parse(await readFile(configPath, "utf8")) as { plugin: string[] }
    expect(isolated.plugin).toEqual(["./reviewer-isolation.js"])
    expect((await stat(configPath)).mode & 0o777).toBe(0o600)
    const bootstrap = await readFile(join(harness.base, "reviewer-isolation.js"), "utf8")
    expect(bootstrap).toContain("cfg.mcp")
  } finally {
    await harness.cleanup()
  }
})

test("reviewer fails closed when its isolated location contains MCP servers", async () => {
  const harness = fixture({ mcpServers: true })
  try {
    const result = await harness.run()
    expect(result.kind).toBe("escalate")
    expect(result.reason).toContain("contains MCP servers")
    expect(harness.state().sessionIDs).toHaveLength(0)
    expect(harness.state().prompts).toBe(0)
  } finally {
    await harness.cleanup()
  }
})

test("a later MCP addition prevents another review in the shared location", async () => {
  const harness = fixture({ mcpServers: "after-first" })
  try {
    expect((await harness.run()).kind).toBe("allow")
    const result = await harness.run()
    expect(result.kind).toBe("escalate")
    expect(result.reason).toContain("contains MCP servers")
    expect(harness.state().sessionIDs).toHaveLength(1)
    expect(harness.state().mcpStatuses).toBe(2)
  } finally {
    await harness.cleanup()
  }
})

test("an MCP status failure escalates instead of proceeding", async () => {
  const harness = fixture({ mcpError: true })
  try {
    const result = await harness.run()
    expect(result.kind).toBe("escalate")
    expect(result.reason).toContain("reviewer isolation")
    expect(harness.state().sessionIDs).toHaveLength(0)
    expect(harness.state().prompts).toBe(0)
  } finally {
    await harness.cleanup()
  }
})

test("a client without an MCP surface escalates instead of proceeding", async () => {
  const harness = fixture({ withoutMcp: true })
  try {
    const result = await harness.run()
    expect(result.kind).toBe("escalate")
    expect(harness.state().sessionIDs).toHaveLength(0)
  } finally {
    await harness.cleanup()
  }
})

test("a second backend re-asserts the config in the shared, persistent location", async () => {
  const first = fixture()
  const base = first.base
  const configPath = join(base, "opencode.json")
  try {
    expect((await first.run()).kind).toBe("allow")
    // The location survives across processes, so a stale/tampered file must be
    // overwritten rather than failing the second backend closed on EEXIST.
    await write(configPath, JSON.stringify({ plugin: [] }), { mode: 0o644 })
    const second = fixture({ base })
    try {
      expect((await second.run()).kind).toBe("allow")
      const isolated = JSON.parse(await readFile(configPath, "utf8")) as { plugin: string[] }
      expect(isolated.plugin).toEqual(["./reviewer-isolation.js"])
      expect((await stat(configPath)).mode & 0o777).toBe(0o600)
    } finally {
      await second.cleanup()
    }
  } finally {
    if (existsSync(base)) await rm(base, { recursive: true, force: true })
  }
})

test("a symlinked config in the location is refused rather than followed", async () => {
  const first = fixture()
  const base = first.base
  const configPath = join(base, "opencode.json")
  const { symlink, readFile: read } = await import("node:fs/promises")
  try {
    expect((await first.run()).kind).toBe("allow")
    // Replace the config with a link to an outside file: a tampered location
    // must escalate, never write through the link.
    await rm(configPath, { force: true })
    const outside = join(base, "..", "outside.json")
    await write(outside, JSON.stringify({ plugin: [] }))
    await symlink(outside, configPath)
    const second = fixture({ base })
    try {
      expect((await second.run()).kind).toBe("escalate")
      expect(JSON.parse(await read(configPath, "utf8")).plugin).toEqual([])
    } finally {
      await second.cleanup()
    }
    await rm(outside, { force: true })
  } finally {
    if (existsSync(base)) await rm(base, { recursive: true, force: true })
  }
})

test("an uncreatable isolation directory escalates without a reviewer session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reviewer-v1-isolation-failure-"))
  const file = join(dir, "file")
  await write(file, "not a directory")
  const harness = fixture()
  const client = harness.client
  try {
    const backend = new V1ReviewerBackend(
      {
        client,
        directory: "/workspace/operational",
        worktree: "/workspace/operational",
        reviewerDirectoryBase: join(file, "child"),
      } as RuntimeContext,
      config({ model: "fixture/reviewer" }),
      () => {},
      () => {},
    )
    const attempt = new ReviewAttempt("generation_fixture", 5000)
    try {
      const result = await backend.review(
        {
          request: request(),
          directory: "/workspace/operational",
          worktree: "/workspace/operational",
          transcript: "Run printf safe",
          intentHistory: "Run printf safe",
          enrichment: "",
          sshAudit: [],
        },
        attempt,
      )
      expect(result.kind).toBe("escalate")
      expect(result.reason).toContain("reviewer isolation unavailable")
      expect(harness.state().sessionIDs).toHaveLength(0)
      expect(harness.state().prompts).toBe(0)
    } finally {
      attempt.close("cancelled")
      await backend.waitForIdle()
    }
  } finally {
    await harness.cleanup()
    await rm(dir, { recursive: true, force: true })
  }
})
