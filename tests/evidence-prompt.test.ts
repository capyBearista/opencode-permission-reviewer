import { describe, expect, test } from "bun:test"
import { buildEvidenceResult } from "../src/context.ts"
import { assembleEvidence } from "../src/context/evidence-assembler.ts"
import type { ContextReader } from "../src/core/ports.ts"
import type { MessageWithParts, ReviewerConfig } from "../src/types.ts"
import { config, request } from "./helpers.ts"

// The evidence text built here is what the Decisions route sends as
// `untrustedEvidence` and what the reasoning reviewer reads.
async function evidenceText(
  reader: ContextReader,
  overrides: Partial<ReviewerConfig> = {},
): Promise<string> {
  const cfg = config(overrides)
  const envelope = await assembleEvidence(request(), [], {
    client: reader,
    directory: "/repo",
    worktree: "/repo",
    config: cfg,
  })
  return buildEvidenceResult(envelope, cfg).text
}

describe("reviewer evidence text", () => {
  for (const kind of ["bounded", "missing-parent", "missing-metadata"] as const) {
    test(`${kind} lineage never presents child messages as human authorization`, async () => {
      const messages: MessageWithParts[] = [
        {
          info: { id: "msg_child", role: "user" },
          parts: [{ type: "text", text: "Run printf safe" }],
        },
      ]
      const reader: ContextReader = {
        messages: async (sessionID) => {
          if (sessionID !== request().sessionID) throw new Error("session.messages 404")
          return messages
        },
        session: async () => {
          if (kind === "missing-metadata") throw new Error("session.get unavailable")
          return { id: request().sessionID, parentID: "ses_missing" }
        },
      }
      const text = await evidenceText(reader, { maxParentSessions: kind === "bounded" ? 0 : 4 })
      expect(text).not.toContain("INTENT actor=user")
      expect(text).toContain("DIRECT_USER_INTENT\n<none />")
      // The child's message is still read, but never as the human's.
      expect(text).toContain(
        kind === "missing-metadata" ? "INTENT actor=unknown" : "INTENT actor=assistant",
      )
    })
  }

  test("a root session's own user message is presented as human intent", async () => {
    const reader: ContextReader = {
      messages: async () => [
        {
          info: { id: "msg_root", role: "user" },
          parts: [{ type: "text", text: "Run printf safe" }],
        },
      ],
      session: async () => ({ id: request().sessionID }),
    }
    expect(await evidenceText(reader)).toContain("INTENT actor=user")
  })

  test("large preceding intent cannot displace the pending action", async () => {
    const reader: ContextReader = {
      messages: async () =>
        [1, 2, 3].map((id) => ({
          info: { id: `msg_${id}`, role: "user" },
          parts: [{ type: "text", text: "a".repeat(7900) }],
        })),
      session: async () => ({ id: request().sessionID }),
    }
    const text = await evidenceText(reader, {
      maxPartChars: 8000,
      maxContextChars: 4000,
      maxEnrichmentChars: 1000,
      maxIntentChars: 1000,
    })
    expect(text.startsWith("PENDING_PERMISSION\n")).toBe(true)
    expect(text).toContain('"command": "printf safe"')
  })
})
