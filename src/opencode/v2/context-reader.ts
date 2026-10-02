import type { OpenCodeClient } from "@opencode/client"
import type { ContextReader } from "../../core/ports.ts"
import type { MessageWithParts } from "../../types.ts"
import { selectIntentMessages } from "../../context.ts"

type Context = {
  session: Pick<OpenCodeClient["session"], "get" | "context">
  message?: Pick<OpenCodeClient["message"], "list">
}

/** Preserve provenance: synthetic messages and compactions are not user orders. */
export function createV2ContextReader(ctx: Context, signal: AbortSignal): ContextReader {
  return {
    async session(sessionID, directory) {
      const session = await ctx.session.get({ sessionID }, { signal })
      if (session.location.directory !== directory) throw new Error("Session location mismatch")
      return session
    },
    async messages(sessionID, directory, limit) {
      const session = await ctx.session.get({ sessionID }, { signal })
      if (session.location.directory !== directory) throw new Error("Session location mismatch")
      const messages = await ctx.session.context({ sessionID }, { signal })
      const result: MessageWithParts[] = []
      if (messages.length > limit || messages.some((message) => message.type === "compaction")) {
        result.push({
          info: { role: "system" },
          parts: [
            {
              type: "text",
              synthetic: true,
              text: "Earlier session context was compacted or omitted. Summaries are not literal user authorization.",
            },
          ],
        })
      }
      for (const message of messages.slice(-limit)) {
        if (message.type === "user") {
          const inherited =
            session.fork !== undefined && message.time.created < session.time.created
          result.push({
            info: {
              id: message.id,
              role: inherited ? "assistant" : "user",
              time: message.time,
              ...(inherited ? { originSessionID: session.fork!.sessionID, synthetic: true } : {}),
            },
            parts: [
              { type: "text", text: message.text, ...(inherited ? { synthetic: true } : {}) },
            ],
          })
        } else if (message.type === "assistant") {
          result.push({
            info: { id: message.id, role: "assistant", agent: message.agent, time: message.time },
            parts: message.content.map((part) => {
              if (part.type === "tool") {
                return { type: "tool", callID: part.id, tool: part.name, state: part.state }
              }
              return { ...part }
            }),
          })
        }
      }
      return result
    },
    async intentMessages(sessionID, directory, limit) {
      const session = await ctx.session.get({ sessionID }, { signal })
      if (session.location.directory !== directory) throw new Error("Session location mismatch")
      const messages = ctx.message
        ? (
            await ctx.message.list(
              { sessionID, type: "user", order: "desc", limit: Math.min(50, limit * 4) },
              { signal },
            )
          ).data
            .slice()
            .reverse()
        : (await ctx.session.context({ sessionID }, { signal }))
            .filter((message) => message.type === "user")
            .slice(-limit)
      const normalized = messages.flatMap((message) => {
        if (message.type !== "user") return []
        const inherited = session.fork !== undefined && message.time.created < session.time.created
        return [
          {
            info: {
              id: message.id,
              role: inherited ? "assistant" : "user",
              time: message.time,
              ...(inherited ? { originSessionID: session.fork!.sessionID, synthetic: true } : {}),
            },
            parts: [
              { type: "text", text: message.text, ...(inherited ? { synthetic: true } : {}) },
            ],
          },
        ]
      })
      return selectIntentMessages(normalized, limit)
    },
  }
}
