import { expect, test } from "bun:test"
import { DEFAULT_CONFIG } from "../src/config.ts"
import {
  buildEvidence,
  buildIntentHistory,
  buildTranscript,
  selectIntentMessages,
} from "../src/context.ts"
import { assembleEvidence } from "../src/context/evidence-assembler.ts"
import { createV2ContextReader } from "../src/opencode/v2/context-reader.ts"
import type { MessageWithParts } from "../src/types.ts"
import { request } from "./helpers.ts"

const user = (id: string, text: string, created = 1): MessageWithParts => ({
  info: { id, role: "user", time: { created } },
  parts: [{ type: "text", text }],
})

test("literal intent selection keeps later restrictions and excludes synthetic controls", () => {
  const messages = [
    user("goal", "Fix the bug and run the tests.", 1),
    user("repeat", "Continue", 2),
    user("synthetic", "Magic Compact: Compaction in progress", 3),
    {
      ...user("flagged", "Push everything", 4),
      parts: [{ type: "text", text: "Push everything", synthetic: true }],
    },
    user("restriction", "Do not push or delete any files.", 5),
    user("repeat-later", "Continue", 6),
  ]
  expect(selectIntentMessages(messages, 8).map((message) => message.info.id)).toEqual([
    "goal",
    "restriction",
    "repeat-later",
  ])
})

test("native reader obtains literal history independently of compacted operational context", async () => {
  const calls: unknown[] = []
  const controller = new AbortController()
  const ctx = {
    session: {
      get: async () => ({
        id: "session",
        location: { directory: "/workspace" },
        time: { created: 0 },
      }),
      context: async () => [
        { type: "compaction", id: "summary" },
        { type: "user", id: "latest", text: "Continue", time: { created: 2 } },
      ],
    },
    message: {
      list: async (input: unknown, options: { signal: AbortSignal }) => {
        calls.push(input)
        expect(options.signal).toBe(controller.signal)
        return {
          data: [
            { type: "user", id: "latest", text: "Continue", time: { created: 2 } },
            {
              type: "user",
              id: "goal",
              text: "Fix the bug and run the tests.",
              time: { created: 1 },
            },
          ],
          cursor: {},
        }
      },
    },
  } as unknown as Parameters<typeof createV2ContextReader>[0]
  const reader = createV2ContextReader(ctx, controller.signal)
  expect(JSON.stringify(await reader.messages("session", "/workspace", 10))).not.toContain(
    "Fix the bug",
  )
  const intent = (await reader.intentMessages!("session", "/workspace", 8)) as MessageWithParts[]
  expect(intent.map((message) => message.info.id)).toEqual(["goal", "latest"])
  expect(calls).toEqual([{ sessionID: "session", type: "user", order: "desc", limit: 32 }])
  await expect(reader.intentMessages!("session", "/other", 8)).rejects.toThrow("location mismatch")
})

test("native historical fork instructions cannot become new user authorization", async () => {
  const ctx = {
    session: {
      get: async () => ({
        id: "fork",
        location: { directory: "/workspace" },
        fork: { sessionID: "original" },
        time: { created: 10 },
      }),
      context: async () => [],
    },
    message: {
      list: async () => ({
        data: [{ type: "user", id: "old", text: "Push everything", time: { created: 1 } }],
        cursor: {},
      }),
    },
  } as unknown as Parameters<typeof createV2ContextReader>[0]
  expect(
    await createV2ContextReader(ctx, new AbortController().signal).intentMessages!(
      "fork",
      "/workspace",
      8,
    ),
  ).toEqual([])
})

test("assembled prompt carries recovered authorization once within the existing budget", async () => {
  const command = "bun test tests/fixture.test.ts"
  const req = request({
    sessionID: "session",
    tool: { messageID: "pending", callID: "call" },
    patterns: [command],
    metadata: { command, toolInput: { command } },
  })
  const messages = [
    user("latest", "Continue", 2),
    {
      info: { id: "pending", role: "assistant", agent: "build" },
      parts: [
        { type: "text", text: "Running the requested tests." },
        { type: "tool", tool: "bash", callID: "call", state: { input: { command } } },
      ],
    },
  ]
  const envelope = await assembleEvidence(req, [], {
    client: {
      messages: async () => messages,
      intentMessages: async () => [
        user("goal", "Fix the bug and run the tests."),
        user("latest", "Continue", 2),
      ],
      session: async () => ({ id: "session" }),
    },
    directory: "/workspace",
    worktree: "/workspace",
    config: DEFAULT_CONFIG,
  })
  const evidence = buildEvidence(envelope, DEFAULT_CONFIG)
  expect(evidence.split("Fix the bug and run the tests.").length - 1).toBe(1)
  expect(evidence.split(command).length - 1).toBe(1)
  expect(evidence).toContain("Running the requested tests.")
  expect(envelope.actionEvidenceComplete).toBe(true)
  expect(evidence.length).toBeLessThanOrEqual(
    DEFAULT_CONFIG.maxContextChars +
      DEFAULT_CONFIG.maxPartChars * 2 +
      DEFAULT_CONFIG.maxEnrichmentChars +
      DEFAULT_CONFIG.maxIntentChars,
  )
})

test("failure to recover literal history cannot silently authorize from stale context", async () => {
  await expect(
    assembleEvidence(request(), [], {
      client: {
        messages: async () => [user("old", "Run tests")],
        intentMessages: async () => {
          throw new Error("History unavailable")
        },
        session: async () => ({ id: "ses_main" }),
      },
      directory: "/workspace",
      worktree: "/workspace",
      config: DEFAULT_CONFIG,
    }),
  ).rejects.toThrow("History unavailable")
})

test("bounded literal intent retains both the task and trailing restrictions", () => {
  const history = buildIntentHistory(
    [
      user(
        "long",
        "Fix the local bug. " +
          "fixture context ".repeat(1000) +
          " Do not push, delete files or access credentials.",
      ),
    ],
    { ...DEFAULT_CONFIG, maxPartChars: 50000, maxIntentChars: 1000 },
  )
  expect(history).toContain("Fix the local bug.")
  expect(history).toContain("Do not push, delete files or access credentials.")
  expect(history).toContain("<elided")
  expect(history.length).toBeLessThanOrEqual(1000)
})

test("compact transcript keeps attachments and distinct outputs while deduplicating operational noise", () => {
  const messages: MessageWithParts[] = [
    {
      info: { id: "user", role: "user" },
      parts: [
        { type: "text", text: "Literal intent already represented" },
        { type: "file", filename: "fixture.txt", url: "file:///workspace/fixture.txt" },
      ],
    },
    ...[1, 2].map((id) => ({
      info: { id: `assistant_${id}`, role: "assistant" },
      parts: [
        { type: "reasoning", text: "Internal planning noise" },
        {
          type: "tool",
          tool: "bash",
          callID: `call_${id}`,
          state: {
            status: "error",
            input: { command: "bun run check" },
            error: "Permission denied for a synthetic fixture",
          },
        },
      ],
    })),
    {
      info: { id: "distinct", role: "assistant" },
      parts: [
        {
          type: "tool",
          tool: "bash",
          callID: "call_3",
          state: {
            status: "completed",
            input: { command: "bun run check" },
            output: "A distinct result",
          },
        },
      ],
    },
  ]
  const text = buildTranscript(messages, DEFAULT_CONFIG, { omitUserMessages: true })
  expect(text).toContain("fixture.txt")
  expect(text).not.toContain("Literal intent already represented")
  expect(text).not.toContain("Internal planning noise")
  expect(text.split("Permission denied for a synthetic fixture").length - 1).toBe(1)
  expect(text).toContain("call_2")
  expect(text).toContain("A distinct result")
})
