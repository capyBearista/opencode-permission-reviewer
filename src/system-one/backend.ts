import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  RateLimitError,
  TypeSafeClient,
} from "@typesafe-ai/sdk"
import type { ReviewAttempt } from "../core/review-attempt.ts"
import { buildEvidenceResult } from "../context.ts"
import { applyEscalationDisposition } from "../escalation.ts"
import { formatFailureReason } from "../failure-reason.ts"
import { DEFAULT_TENANT_POLICY, REVIEWER_SYSTEM_PROMPT } from "../policy.ts"
import { redactSecrets } from "../redact.ts"
import { splitModel } from "../config.ts"
import type { ReviewEnvelope, ReviewExecutionResult, ReviewerConfig } from "../types.ts"
import {
  enforceParsedSystemOneReview,
  parseSystemOneReview,
  SYSTEM_ONE_QUESTIONS,
  type ParsedSystemOneReview,
  type SystemOneState,
} from "./review.ts"

export type ReasoningEscalation = (
  envelope: ReviewEnvelope,
  attempt: ReviewAttempt,
) => Promise<ReviewExecutionResult>

export type SystemOneInvoke = (state: SystemOneState, signal: AbortSignal) => Promise<unknown>

/** Legacy authenticated transports retain their existing SDK retry policy. */
const SYSTEM_ONE_RETRY = {
  maxRetries: 2,
  backoffInitialMs: 400,
  backoffMaxMs: 800,
  httpStatuses: new Set([503]),
  respectRetryAfter: false,
  apiConnectionError: false,
  apiTimeoutError: false,
}

const FREE_MODEL = "opencode/jev-1.13-free"
const FREE_MAX_ATTEMPTS = 3
const FREE_TIMEOUT_MS = 10_000
const PAID_TIMEOUT_MS = 15_000

/** Only failures of the free transport/protocol can trigger paid routing. */
type FreeFailure = {
  reason: string
  retry: boolean
  fallback: boolean
  retryAfterMs?: number
}

function classifyFreeFailure(error: unknown): FreeFailure {
  if (error instanceof APIError) {
    const status = error.status
    if ([400, 413, 422].includes(status))
      return { reason: "invalid-request", retry: false, fallback: false }
    if ([401, 402, 403].includes(status))
      return { reason: "access-unavailable", retry: false, fallback: true }
    if ([404, 410].includes(status))
      return { reason: "endpoint-unavailable", retry: false, fallback: true }
    if (status === 408 || status === 429 || status >= 500) {
      return {
        reason:
          status === 429 ? "rate-limited" : status === 408 ? "request-timeout" : "server-error",
        retry: true,
        fallback: true,
        ...(error instanceof RateLimitError && error.retryAfterMs !== undefined
          ? { retryAfterMs: error.retryAfterMs }
          : {}),
      }
    }
    return { reason: "unexpected-http-status", retry: false, fallback: false }
  }
  if (error instanceof APIUserAbortError)
    return { reason: "cancelled", retry: false, fallback: false }
  if (
    error instanceof APITimeoutError ||
    (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name))
  )
    return { reason: "request-timeout", retry: true, fallback: true }
  if (error instanceof APIConnectionError || error instanceof TypeError)
    return { reason: "network-error", retry: true, fallback: true }
  if (error instanceof SyntaxError)
    return { reason: "invalid-response", retry: true, fallback: true }
  return { reason: "unexpected-error", retry: false, fallback: false }
}

/** Cancel-aware delay: never start another review operation after the deadline. */
function backoff(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const cancel = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel)
      resolve()
    }, ms)
    signal.addEventListener("abort", cancel, { once: true })
  })
}

export interface SystemOneFallbackRoute {
  model: "openrouter/typesafe/jev-1.13"
  invoke: SystemOneInvoke
}

function reconcileReasoningEscalation(result: ReviewExecutionResult): ReviewExecutionResult {
  if (result.kind !== "allow" || result.decision?.evidence_completeness === "sufficient") {
    return result
  }
  const reviewerOutcome = result.decision?.outcome ?? result.reviewerOutcome
  return {
    ...result,
    kind: "escalate",
    reason:
      "The reasoning reviewer did not find sufficient evidence to override the System One escalation.",
    ...(reviewerOutcome === undefined ? {} : { reviewerOutcome }),
  }
}

export function createSystemOneInvoker(
  config: ReviewerConfig,
  fetchImpl?: TypeSafeClient["fetch"],
  auth?: { apiKey: string; disableRetries?: boolean },
): SystemOneInvoke {
  const { providerID, modelID } = splitModel(config.model)
  const requestModel =
    providerID === "openrouter" && modelID === "typesafe/jev-1.13" ? "jev-1.13" : modelID
  if (config.model === FREE_MODEL) {
    // The TypeSafe SDK requires a key and always adds an Authorization header.
    // Zen's promotional endpoint is deliberately anonymous.
    const request = fetchImpl ?? globalThis.fetch
    return async (state, signal) => {
      const response = await request("https://opencode.ai/zen/v1/systemone", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-opencode-client": "opencode-permission-reviewer",
        },
        body: JSON.stringify({ model: modelID, state, questions: SYSTEM_ONE_QUESTIONS }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
      })
      if (!response.ok) {
        const body = await response.text()
        throw APIError.fromResponse(response.status, body, response.headers)
      }
      return response.json()
    }
  }
  const keyName =
    providerID === "opencode"
      ? "OPENCODE_API_KEY"
      : providerID === "commandcode"
        ? "CMD_API_KEY"
        : providerID === "openrouter"
          ? "OPENROUTER_API_KEY"
          : "TYPESAFE_API_KEY"
  const apiKey = auth?.apiKey ?? process.env[keyName]?.trim()
  if (!apiKey) throw new Error(`Missing ${keyName} for System One reviewer ${config.model}`)
  const client = new TypeSafeClient({
    apiKey,
    ...(providerID === "opencode"
      ? { baseURL: "https://opencode.ai/zen" }
      : providerID === "commandcode"
        ? { baseURL: "https://api.commandcode.ai/provider" }
        : providerID === "openrouter"
          ? { baseURL: "https://openrouter.ai/api" }
          : {}),
    defaultModel: requestModel,
    logLevel: "off",
    timeout: config.timeoutMs,
    retry: auth?.disableRetries ? { maxRetries: 0 } : SYSTEM_ONE_RETRY,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  })
  return async (state, signal) => {
    const deadline = AbortSignal.timeout(config.timeoutMs)
    const boundedSignal = AbortSignal.any([signal, deadline])
    const { data } = await client
      .systemOne(
        { model: requestModel, state, questions: SYSTEM_ONE_QUESTIONS },
        { signal: boundedSignal, timeout: config.timeoutMs },
      )
      .withResponse()
    return data
  }
}

/** Calls Jev directly and delegates only valid but difficult decisions. */
export class SystemOneReviewerBackend {
  private readonly jobs = new Set<Promise<ReviewExecutionResult>>()

  constructor(
    private readonly config: ReviewerConfig,
    private readonly escalation?: ReasoningEscalation,
    private readonly escalationModel?: string,
    private readonly invoke?: SystemOneInvoke,
    private readonly recordReviewerMs?: (envelope: ReviewEnvelope, ms: number) => void,
    private readonly fallback?: SystemOneFallbackRoute,
  ) {}

  owns(): boolean {
    return false
  }

  review(
    envelope: ReviewEnvelope,
    attempt: ReviewAttempt,
    escalation: ReasoningEscalation | undefined = this.escalation,
  ): Promise<ReviewExecutionResult> {
    const job = this.runReview(envelope, attempt, escalation).finally(() => this.jobs.delete(job))
    this.jobs.add(job)
    return job
  }

  async waitForIdle(): Promise<void> {
    await Promise.allSettled([...this.jobs])
  }

  private async runReview(
    envelope: ReviewEnvelope,
    attempt: ReviewAttempt,
    escalation: ReasoningEscalation | undefined,
  ): Promise<ReviewExecutionResult> {
    const started = performance.now()
    let fallbackInfo: Pick<
      ReviewExecutionResult,
      "fallbackFrom" | "fallbackReason" | "fallbackAttempts"
    > = {}
    try {
      const evidence = buildEvidenceResult(envelope, this.config)
      envelope.actionEvidenceComplete =
        envelope.actionEvidenceComplete !== false && evidence.actionEvidenceComplete
      const state: SystemOneState = {
        trustedPolicy: {
          reviewer: REVIEWER_SYSTEM_PROMPT,
          tenant: redactSecrets(this.config.policy ?? DEFAULT_TENANT_POLICY),
        },
        untrustedEvidence: evidence.text,
      }

      const primary = this.invoke ?? createSystemOneInvoker(this.config)
      let decidingModel = this.config.model
      let response: unknown
      let parsed: ParsedSystemOneReview | undefined

      // An explicit, trusted fallback enables bounded retries; all other
      // reviewer configurations retain their existing single-invocation path.
      if (this.config.model === FREE_MODEL && this.config.systemOneFallback) {
        let failure: FreeFailure = {
          reason: "invalid-response",
          retry: true,
          fallback: true,
        }
        let freeAttempts = 0
        for (let index = 0; index < FREE_MAX_ATTEMPTS; index++) {
          if (!attempt.active()) throw new Error("Review cancelled or expired")
          freeAttempts++
          const timeout = Math.min(FREE_TIMEOUT_MS, attempt.remainingMs())
          try {
            response = await attempt.wait(
              primary(state, AbortSignal.any([attempt.signal, AbortSignal.timeout(timeout)])),
            )
            parsed = parseSystemOneReview(response, this.config)
            if (parsed) break
            failure = { reason: "invalid-response", retry: true, fallback: true }
          } catch (error) {
            if (!attempt.active()) throw error
            failure = classifyFreeFailure(error)
            if (!failure.fallback) throw error
          }
          if (!failure.retry || index === FREE_MAX_ATTEMPTS - 1) break
          const delay = failure.retryAfterMs ?? 400 * 2 ** index
          // Never hold the host on a long Retry-After or consume the entire
          // review budget waiting for a throttled promotional endpoint.
          if (delay > 2_000 || delay + PAID_TIMEOUT_MS >= attempt.remainingMs()) break
          await attempt.wait(backoff(delay, attempt.signal))
        }

        if (!parsed) {
          fallbackInfo = {
            fallbackFrom: this.config.model,
            fallbackReason: failure.reason,
            fallbackAttempts: freeAttempts,
          }
          if (!this.fallback || this.fallback.model !== this.config.systemOneFallback.model)
            throw new Error("Trusted OpenRouter fallback is not available")
          if (!attempt.active() || attempt.remainingMs() === 0)
            throw new Error("Review deadline expired before fallback")
          decidingModel = this.fallback.model
          const timeout = Math.min(PAID_TIMEOUT_MS, attempt.remainingMs())
          response = await attempt.wait(
            this.fallback.invoke(
              state,
              AbortSignal.any([attempt.signal, AbortSignal.timeout(timeout)]),
            ),
          )
          parsed = parseSystemOneReview(response, { ...this.config, model: decidingModel })
        }
      } else {
        response = await attempt.wait(primary(state, attempt.signal))
        parsed = parseSystemOneReview(response, this.config)
      }

      if (!parsed) {
        return applyEscalationDisposition(
          {
            kind: "escalate",
            reason: "System One reviewer returned a missing, invalid, or ambiguous decision.",
            decisionSource: "failure-safe",
            ...fallbackInfo,
          },
          this.config,
          "invalid-decision",
        )
      }

      const enforced = enforceParsedSystemOneReview(parsed, this.config)
      if (enforced.kind !== "escalate") {
        return {
          ...enforced,
          decisionSource: "system-one-reviewer",
          reviewerModel: decidingModel,
          ...fallbackInfo,
        }
      }

      if (escalation && this.escalationModel && parsed.reasoningRecommended) {
        const secondary = reconcileReasoningEscalation(await escalation(envelope, attempt))
        return {
          ...secondary,
          reviewerModel: secondary.reviewerModel ?? this.escalationModel,
          reviewerEscalatedFrom: { model: decidingModel, reason: enforced.reason },
          ...fallbackInfo,
        }
      }

      return applyEscalationDisposition(
        {
          ...enforced,
          decisionSource: "system-one-reviewer",
          reviewerModel: decidingModel,
          ...fallbackInfo,
        },
        this.config,
        "general",
      )
    } catch (error) {
      return applyEscalationDisposition(
        {
          kind: "escalate",
          reason:
            error instanceof APIError
              ? `System One reviewer failed (HTTP ${error.status}).`
              : formatFailureReason("System One reviewer", error),
          decisionSource: "failure-safe",
          ...fallbackInfo,
        },
        this.config,
        "reviewer-failure",
      )
    } finally {
      const elapsed = performance.now() - started
      envelope.timings = { ...envelope.timings, reviewerMs: elapsed }
      this.recordReviewerMs?.(envelope, elapsed)
    }
  }
}
