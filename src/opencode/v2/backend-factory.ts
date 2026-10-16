import type { OpenCodeClient } from "@opencode/client"
import type { Plugin } from "@opencode/plugin"
import type { ReviewAttempt } from "../../core/review-attempt.ts"
import { createDecisionsTransport } from "../../system-one/decisions-transport.ts"
import { DecisionsReviewerBackend } from "../../system-one/decisions-backend.ts"
import type { ReviewEnvelope, ReviewExecutionResult, ReviewerConfig } from "../../types.ts"
import { V2ReviewerBackend } from "./reviewer-backend.ts"

type Context = Parameters<Plugin.Plugin["setup"]>[0]

export interface V2ReviewBackend {
  owns(sessionID: string): boolean
  review(
    envelope: ReviewEnvelope,
    attempt: ReviewAttempt,
    client: OpenCodeClient,
  ): Promise<ReviewExecutionResult>
  waitForIdle(): Promise<void>
  dispose(): Promise<void>
}

function reasoningConfig(config: ReviewerConfig): ReviewerConfig | undefined {
  const reasoning = config.reasoningModels?.[0]
  if (!reasoning) return
  return {
    ...config,
    model: reasoning.model,
    variant: reasoning.variant,
    outputFormat: reasoning.outputFormat,
    timeoutMs: reasoning.timeoutMs,
  }
}

export function createV2ReviewerBackend(context: Context, config: ReviewerConfig): V2ReviewBackend {
  const secondaryConfig = reasoningConfig(config)
  const secondary = secondaryConfig ? new V2ReviewerBackend(context, secondaryConfig) : undefined
  const primary = new DecisionsReviewerBackend({
    config,
    transport: createDecisionsTransport({
      resolveOpenRouterKey: async (signal: AbortSignal) => {
        if (!signal || signal.aborted) return
        const connection = await context.integration.connection.active("openrouter")
        if (signal.aborted) return
        if (!connection || connection.type !== "credential" || connection.method !== "key") return
        const credential = await context.integration.connection.resolve(connection)
        if (signal.aborted) return
        if (credential?.type !== "key" || !credential.key.trim()) return
        return credential.key
      },
    }),
    ...(secondaryConfig && secondary
      ? {
          reasoning: {
            model: secondaryConfig.model,
            review: (envelope: ReviewEnvelope, attempt: ReviewAttempt, client: OpenCodeClient) =>
              secondary.review(envelope, attempt, client),
          },
        }
      : {}),
  })

  return {
    owns: (sessionID) => secondary?.owns(sessionID) ?? false,
    review: (envelope, attempt, client) => primary.review(envelope, attempt, client),
    waitForIdle: async () => {
      await Promise.all([primary.waitForIdle(), secondary?.waitForIdle()])
    },
    dispose: async () => {
      await primary.waitForIdle()
      await secondary?.dispose()
    },
  }
}
