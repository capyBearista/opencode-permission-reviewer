import type { OpenCodeClient } from "@opencode/client"
import type { Plugin } from "@opencode/plugin"
import type { ReviewAttempt } from "../../core/review-attempt.ts"
import { isSystemOneReviewerModel } from "../../config.ts"
import {
  createSystemOneInvoker,
  SystemOneReviewerBackend,
  type SystemOneFallbackRoute,
} from "../../system-one/backend.ts"
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

function escalationConfig(config: ReviewerConfig): ReviewerConfig | undefined {
  const escalation = config.escalationReviewer
  if (!escalation) return
  const base = { ...config }
  delete base.escalationReviewer
  return {
    ...base,
    ...escalation,
  }
}

export function createV2ReviewerBackend(context: Context, config: ReviewerConfig): V2ReviewBackend {
  if (!isSystemOneReviewerModel(config.model)) return new V2ReviewerBackend(context, config)
  const secondaryConfig = escalationConfig(config)
  const secondary = secondaryConfig ? new V2ReviewerBackend(context, secondaryConfig) : undefined
  const fallback: SystemOneFallbackRoute | undefined = config.systemOneFallback
    ? {
        model: config.systemOneFallback.model,
        invoke: async (state: Parameters<ReturnType<typeof createSystemOneInvoker>>[0], signal: AbortSignal) => {
          // Resolve the active credential only when a paid request is required.
          // Never read arbitrary environment keys or expose credential material to audit.
          const connection = await context.integration.connection.active("openrouter")
          if (!connection || connection.type !== "credential")
            throw new Error("No active saved OpenRouter connection for System One fallback")
          const credential = await context.integration.connection.resolve(connection)
          if (credential?.type !== "key" || !credential.key.trim())
            throw new Error("OpenRouter fallback requires an active API-key connection")
          return createSystemOneInvoker(
            { ...config, model: config.systemOneFallback!.model },
            undefined,
            { apiKey: credential.key, disableRetries: true },
          )(state, signal)
        },
      }
    : undefined
  const primary = new SystemOneReviewerBackend(
    config,
    undefined,
    secondaryConfig?.model,
    undefined,
    undefined,
    fallback,
  )
  return {
    owns: (sessionID) => secondary?.owns(sessionID) ?? false,
    review: (envelope, attempt, client) =>
      primary.review(
        envelope,
        attempt,
        secondary ? (value, current) => secondary.review(value, current, client) : undefined,
      ),
    waitForIdle: async () => {
      await Promise.all([primary.waitForIdle(), secondary?.waitForIdle()])
    },
    dispose: async () => {
      await Promise.all([primary.waitForIdle(), secondary?.dispose()])
    },
  }
}
