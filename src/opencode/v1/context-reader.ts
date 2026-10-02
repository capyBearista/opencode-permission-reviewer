import type { ContextReader } from "../../core/ports.ts"
import type { OpenCodeClientLike } from "../types.ts"
import { responseData, withTimeout } from "../transport.ts"
import { normalizeMessages, selectIntentMessages } from "../../context.ts"

const MAX_INTENT_SCAN_MESSAGES = 2_000

export function createV1ContextReader(
  client: OpenCodeClientLike,
  signal?: AbortSignal,
): ContextReader {
  // Share concurrent reads only: permission reviews must never reuse old state.
  const reads = new Map<string, Promise<unknown>>()
  const read = (sessionID: string, directory: string, limit: number): Promise<unknown> => {
    const key = JSON.stringify([sessionID, directory, limit])
    const existing = reads.get(key)
    if (existing) return existing
    const pending = client.session
      .messages({
        path: { id: sessionID },
        query: { directory, limit },
        ...(signal ? { signal } : {}),
      })
      .then((response) => responseData(response, "session.messages"))
    reads.set(key, pending)
    void pending.finally(() => reads.delete(key)).catch(() => {})
    return pending
  }
  return {
    async messages(sessionID, directory, limit) {
      return read(sessionID, directory, limit)
    },
    async intentMessages(sessionID, directory, limit) {
      const metadataPromise = client.session.get
        ? withTimeout(
            client.session.get({
              path: { id: sessionID },
              query: { directory },
              ...(signal ? { signal } : {}),
            }),
            10_000,
          )
            .then((response) => responseData(response, "session.get"))
            .catch(() => undefined)
        : undefined
      let window = Math.min(MAX_INTENT_SCAN_MESSAGES, Math.max(200, limit * 4))
      const [metadata, initial] = await Promise.all([
        metadataPromise,
        read(sessionID, directory, window),
      ])
      let pending = Promise.resolve(initial)
      const session =
        typeof metadata === "object" && metadata !== null
          ? (metadata as Record<string, unknown>)
          : undefined
      const time = session?.time as { created?: unknown } | undefined
      const createdAt = typeof time?.created === "number" ? time.created : undefined
      while (true) {
        const messages = normalizeMessages(await pending)
        const users = selectIntentMessages(
          messages.filter((message) => {
            const time = message.info.time as { created?: unknown } | undefined
            return (
              createdAt === undefined ||
              typeof time?.created !== "number" ||
              time.created >= createdAt
            )
          }),
          limit,
        )
        if (
          users.length >= limit ||
          messages.length < window ||
          window === MAX_INTENT_SCAN_MESSAGES
        )
          return users.slice(-limit)
        window = Math.min(MAX_INTENT_SCAN_MESSAGES, window * 2)
        pending = read(sessionID, directory, window)
      }
    },
    async session(sessionID, directory) {
      if (!client.session.get) return undefined
      return responseData(
        await client.session.get({
          path: { id: sessionID },
          query: { directory },
          ...(signal ? { signal } : {}),
        }),
        "session.get",
      )
    },
  }
}
