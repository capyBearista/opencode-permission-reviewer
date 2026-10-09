import { expect, test } from "bun:test"
import type { OpenCodeClient } from "@opencode/client"
import type { Plugin } from "@opencode/plugin"
import { resolveConfig } from "../src/config.ts"
import { ReviewAttempt } from "../src/core/review-attempt.ts"
import { createV2ReviewerBackend } from "../src/opencode/v2/backend-factory.ts"
import { SYSTEM_ONE_QUESTIONS } from "../src/system-one/review.ts"
import type { ReviewEnvelope } from "../src/types.ts"

function decision(model: string) {
  const selected: Record<string, string> = {
    outcome: "allow",
    risk_level: "low",
    user_authorization: "high",
    scope_alignment: "aligned",
    evidence_completeness: "sufficient",
    primary_basis: "authorized_routine",
  }
  return {
    model,
    usage: { input_tokens: 20, output_tokens: 0 },
    answers: Object.fromEntries(
      Object.entries(SYSTEM_ONE_QUESTIONS).map(([name, question]) => {
        if (question.type === "noul") {
          return [name, {
            type: "noul",
            noul: ["material_authorization", "within_intent_scope"].includes(name) ? 1 : 0,
          }]
        }
        const values = Object.keys(question.criteria)
        const chosen = selected[name]!
        return [name, {
          type: "choice",
          choice: chosen,
          confidence: 1,
          probabilities: Object.fromEntries(values.map((value) => [value, value === chosen ? 1 : 0])),
        }]
      }),
    ),
  }
}

function envelope(): ReviewEnvelope {
  return {
    request: {
      id: "request",
      sessionID: "session",
      permission: "bash",
      patterns: ["printf ok"],
      metadata: { command: "printf ok" },
      always: [],
    },
    directory: "/workspace",
    worktree: "/workspace",
    transcript: "User authorized printf ok",
    intentHistory: "User authorized printf ok",
    enrichment: "",
    sshAudit: [],
  }
}

test("V2 factory retrieves saved OpenRouter credentials only after free access fails", async () => {
  const original = globalThis.fetch
  let resolves = 0
  let opens = 0
  const requests: string[] = []
  const context = {
    integration: {
      connection: {
        active: async (id: string) => {
          expect(id).toBe("openrouter")
          opens++
          return { type: "credential", id: "credo", method: "key", label: "saved" }
        },
        resolve: async () => {
          resolves++
          return { type: "key", key: "synthetic-saved-key" }
        },
      },
    },
  } as unknown as Parameters<Plugin.Plugin["setup"]>[0]

  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const target = String(url)
    requests.push(target)
    if (target.includes("opencode.ai/zen")) {
      expect(new Headers(init?.headers).has("authorization")).toBe(false)
      return Response.json({ error: "Unavailable" }, { status: 403 })
    }
    expect(target).toBe("https://openrouter.ai/api/v1/systemone")
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-saved-key")
    expect(JSON.parse(String(init?.body)).model).toBe("jev-1.13")
    return Response.json(decision("typesafe/jev-1.13-20260917"))
  }) as typeof fetch

  const config = resolveConfig({
    model: "opencode/jev-1.13-free",
    systemOneFallback: { model: "openrouter/typesafe/jev-1.13" },
  })
  const backend = createV2ReviewerBackend(context, config)
  const attempt = new ReviewAttempt("generation", 8000)
  try {
    const result = await backend.review(envelope(), attempt, {} as OpenCodeClient)
    expect(result.kind).toBe("allow")
    expect(result.reviewerModel).toBe("openrouter/typesafe/jev-1.13")
    expect(result.fallbackFrom).toBe("opencode/jev-1.13-free")
    expect(opens).toBe(1)
    expect(resolves).toBe(1)
    expect(requests).toHaveLength(2)
  } finally {
    attempt.close("finished")
    globalThis.fetch = original
    await backend.dispose()
  }
})

test("V2 factory does not resolve paid credentials for valid free decisions", async () => {
  const original = globalThis.fetch
  let paid = 0
  let connections = 0
  const context = {
    integration: {
      connection: {
        active: async () => { connections++; return undefined },
      },
    },
  } as unknown as Parameters<Plugin.Plugin["setup"]>[0]

  globalThis.fetch = (async () => {
    paid++
    return Response.json(decision("jev-1.13-free"))
  }) as typeof fetch

  const backend = createV2ReviewerBackend(
    context,
    resolveConfig({
      model: "opencode/jev-1.13-free",
      systemOneFallback: { model: "openrouter/typesafe/jev-1.13" },
    }),
  )
  const attempt = new ReviewAttempt("generation", 8000)
  try {
    const result = await backend.review(envelope(), attempt, {} as OpenCodeClient)
    expect(result.kind).toBe("allow")
    expect(paid).toBe(1)
    expect(connections).toBe(0)
  } finally {
    attempt.close("finished")
    globalThis.fetch = original
    await backend.dispose()
  }
})
