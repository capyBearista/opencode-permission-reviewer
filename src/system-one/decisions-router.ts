import type { ReviewAttempt } from "../core/review-attempt.ts"
import type { ReviewerConfig } from "../types.ts"
import { parseSystemOneReview, type ParsedSystemOneReview, type SystemOneState } from "./review.ts"
import { DecisionsTransportError, type DecisionsTransport } from "./decisions-transport.ts"

export type DecisionsAttemptOutcome =
  | "selected"
  | "invalid-decision"
  | "network-error"
  | "timeout"
  | "cancelled"
  | "deadline-exceeded"
  | "missing-credentials"
  | "access-unavailable"
  | "endpoint-unavailable"
  | "model-not-found"
  | "model-rejected"
  | "http-retryable"
  | "invalid-request"
  | "unexpected-http-status"
  | "internal-error"

export interface DecisionAttemptRecord {
  model: string
  modelIndex: number
  attempt: number
  requestSent: boolean
  outcome: DecisionsAttemptOutcome
  httpStatus?: number
  durationMs: number
  responseModel?: string
}

export interface DecisionsRouteTrace {
  /** Live bounded trace; cancellation finalizes its in-flight entry synchronously. */
  readonly attempts: DecisionAttemptRecord[]
}

export type DecisionsSelection =
  | {
      kind: "selected"
      model: string
      parsed: ParsedSystemOneReview
      attempts: DecisionAttemptRecord[]
    }
  | {
      kind: "failed"
      category: "invalid-decision" | "reviewer-failure"
      reason: string
      attempts: DecisionAttemptRecord[]
    }

export interface DecisionsRouterOptions {
  /** Base review policy used only by the parser; enforcement remains with caller. */
  config: ReviewerConfig
  models: readonly string[]
  attemptsPerModel?: number
  timeoutMs?: number
  transport: DecisionsTransport
}

interface CurrentAttempt {
  model: string
  modelIndex: number
  attempt: number
  startedAt: number
  requestSent: boolean
  record?: DecisionAttemptRecord
}

type FailureClassification = {
  outcome: DecisionsAttemptOutcome
  category: "invalid-decision" | "reviewer-failure"
  action: "retry" | "next-model" | "stop"
  operational: boolean
  httpStatus?: number
  reason: string
}

const MAX_MODELS = 8
const MAX_ATTEMPTS_PER_MODEL = 5
const MAX_TRACE_RECORDS = MAX_MODELS * MAX_ATTEMPTS_PER_MODEL

export function createDecisionsRouteTrace(): DecisionsRouteTrace {
  return { attempts: [] }
}

function boundedAttempts(value: number | undefined): number {
  if (!Number.isFinite(value)) return 2
  return Math.max(1, Math.min(MAX_ATTEMPTS_PER_MODEL, Math.floor(value!)))
}

function boundedTimeout(value: number | undefined): number {
  if (!Number.isFinite(value)) return 10_000
  return Math.max(1, Math.min(60_000, Math.floor(value!)))
}

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

function httpFailure(error: DecisionsTransportError, nativeModel: string): FailureClassification {
  const status = error.status
  if (status === undefined) {
    return {
      outcome: "internal-error",
      category: "reviewer-failure",
      action: "stop",
      operational: false,
      reason: "Decisions transport failed unexpectedly.",
    }
  }
  if ([401, 402, 403].includes(status)) {
    return {
      outcome: "access-unavailable",
      category: "reviewer-failure",
      action: "next-model",
      operational: true,
      httpStatus: status,
      reason: `Decisions provider access is unavailable (HTTP ${status}).`,
    }
  }
  if (status === 404 || status === 410) {
    return {
      outcome: "endpoint-unavailable",
      category: "reviewer-failure",
      action: "next-model",
      operational: true,
      httpStatus: status,
      reason: `Decisions endpoint is unavailable (HTTP ${status}).`,
    }
  }
  if (status === 400 && error.explicitlyNamesMissingModel(nativeModel)) {
    return {
      outcome: "model-not-found",
      category: "reviewer-failure",
      action: "next-model",
      operational: true,
      httpStatus: status,
      reason: "A configured Decisions model is unavailable.",
    }
  }
  if (status === 408 || status === 429 || (status >= 500 && status <= 599)) {
    return {
      outcome: "http-retryable",
      category: "reviewer-failure",
      action: "retry",
      operational: true,
      httpStatus: status,
      reason: `Decisions provider returned HTTP ${status}.`,
    }
  }
  // Size and validation limits are per model (e.g. a 16k context window), so a
  // model with larger limits can still accept the same request.
  if (status === 413 || status === 422) {
    return {
      outcome: "model-rejected",
      category: "reviewer-failure",
      action: "next-model",
      operational: true,
      httpStatus: status,
      reason: `Decisions model rejected the request (HTTP ${status}).`,
    }
  }
  if (status === 400) {
    return {
      outcome: "invalid-request",
      category: "reviewer-failure",
      action: "stop",
      operational: false,
      httpStatus: status,
      reason: `Decisions provider rejected the request (HTTP ${status}).`,
    }
  }
  return {
    outcome: "unexpected-http-status",
    category: "reviewer-failure",
    action: "stop",
    operational: false,
    httpStatus: status,
    reason: `Decisions provider returned an unexpected HTTP status (${status}).`,
  }
}

function classifyFailure(error: unknown, nativeModel: string): FailureClassification {
  if (error instanceof DecisionsTransportError) {
    if (error.kind === "http") return httpFailure(error, nativeModel)
    if (error.kind === "response-too-large") {
      if (error.status !== undefined && (error.status < 200 || error.status >= 300))
        return httpFailure(
          new DecisionsTransportError("http", {
            requestSent: error.requestSent,
            status: error.status,
          }),
          nativeModel,
        )
      return {
        outcome: "invalid-decision",
        category: "invalid-decision",
        action: "retry",
        operational: false,
        reason: "Decisions response exceeded the allowed size.",
      }
    }
    if (error.kind === "invalid-json") {
      return {
        outcome: "invalid-decision",
        category: "invalid-decision",
        action: "retry",
        operational: false,
        reason: "Decisions response was not valid JSON.",
      }
    }
    if (error.kind === "missing-credentials") {
      return {
        outcome: "missing-credentials",
        category: "reviewer-failure",
        action: "next-model",
        operational: true,
        reason: "OpenRouter credentials are unavailable.",
      }
    }
    if (error.kind === "timeout") {
      return {
        outcome: "timeout",
        category: "reviewer-failure",
        action: "retry",
        operational: true,
        reason: "Decisions attempt timed out.",
      }
    }
    if (error.kind === "cancelled") {
      return {
        outcome: "cancelled",
        category: "reviewer-failure",
        action: "stop",
        operational: true,
        reason: "Review cancelled or expired.",
      }
    }
    if (error.kind === "network") {
      return {
        outcome: "network-error",
        category: "reviewer-failure",
        action: "retry",
        operational: true,
        reason: "Decisions transport failed.",
      }
    }
    return {
      outcome: "internal-error",
      category: "reviewer-failure",
      action: "stop",
      operational: false,
      reason: "Decisions transport failed unexpectedly.",
    }
  }
  if (error instanceof TypeError) {
    return {
      outcome: "network-error",
      category: "reviewer-failure",
      action: "retry",
      operational: true,
      reason: "Decisions transport failed.",
    }
  }
  return {
    outcome: "internal-error",
    category: "reviewer-failure",
    action: "stop",
    operational: false,
    reason: "Decisions transport failed unexpectedly.",
  }
}

function nativeModel(model: string): string {
  const slash = model.indexOf("/")
  return slash < 0 ? model : model.slice(slash + 1)
}

export function createDecisionsRouter(options: DecisionsRouterOptions) {
  const models = options.models.slice(0, MAX_MODELS)
  const attemptsPerModel = boundedAttempts(options.attemptsPerModel)
  const timeoutMs = boundedTimeout(options.timeoutMs)

  return async function select(
    state: SystemOneState,
    attempt: ReviewAttempt,
    suppliedTrace?: DecisionsRouteTrace,
  ): Promise<DecisionsSelection> {
    const trace = suppliedTrace ?? createDecisionsRouteTrace()
    let current: CurrentAttempt | undefined
    let structuralSeen = false
    let operationalSeen = false
    let lastCategory: FailureClassification["category"] = "reviewer-failure"
    let lastReason = "No configured Decisions models are available."

    const addRecord = (
      active: CurrentAttempt,
      outcome: DecisionsAttemptOutcome,
      httpStatus?: number,
      responseModel?: string,
    ) => {
      if (active.record) return active.record
      const record: DecisionAttemptRecord = {
        model: active.model,
        modelIndex: active.modelIndex,
        attempt: active.attempt,
        requestSent: active.requestSent,
        outcome,
        durationMs: Math.max(0, performance.now() - active.startedAt),
        ...(httpStatus === undefined ? {} : { httpStatus }),
        ...(responseModel === undefined ? {} : { responseModel }),
      }
      if (trace.attempts.length < MAX_TRACE_RECORDS) trace.attempts.push(record)
      active.record = record
      return record
    }

    const abortCurrent = () => {
      if (!current) return
      const outcome = attempt.state === "expired" ? "deadline-exceeded" : "cancelled"
      addRecord(current, outcome)
    }

    const removeAbortListener = () => attempt.signal.removeEventListener("abort", abortCurrent)
    attempt.signal.addEventListener("abort", abortCurrent, { once: true })

    const result = (
      category: FailureClassification["category"],
      reason: string,
      applyExhaustionPrecedence = true,
    ): DecisionsSelection => {
      const chosenCategory = !applyExhaustionPrecedence
        ? category
        : structuralSeen && options.config.riskPolicy.onInvalidDecision === "deny"
          ? "invalid-decision"
          : operationalSeen && options.config.riskPolicy.onReviewerFailure === "deny"
            ? "reviewer-failure"
            : category
      return {
        kind: "failed",
        category: chosenCategory,
        reason,
        attempts: trace.attempts.slice(0, MAX_TRACE_RECORDS),
      }
    }

    try {
      if (!attempt.active()) {
        return result(
          "reviewer-failure",
          "Review cancelled or expired before Decisions routing.",
          false,
        )
      }
      if (models.length === 0) return result("reviewer-failure", lastReason)

      for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
        const model = models[modelIndex]!
        let moveToNextModel = false
        for (let attemptIndex = 1; attemptIndex <= attemptsPerModel; attemptIndex++) {
          if (!attempt.active()) {
            abortCurrent()
            return result("reviewer-failure", "Review cancelled or expired.", false)
          }
          const remainingMs = attempt.remainingMs()
          if (remainingMs <= 0) {
            abortCurrent()
            return result(
              "reviewer-failure",
              "Review deadline expired before a Decisions attempt.",
              false,
            )
          }

          const active: CurrentAttempt = {
            model,
            modelIndex,
            attempt: attemptIndex,
            startedAt: performance.now(),
            requestSent: false,
          }
          current = active
          let response: unknown
          try {
            const operation = Promise.resolve(
              options.transport({
                model,
                state,
                signal: attempt.signal,
                timeoutMs: Math.min(timeoutMs, remainingMs),
                onRequestSent: () => {
                  active.requestSent = true
                },
              }),
            )
            response = await attempt.wait(operation)
          } catch (error) {
            if (!attempt.active()) {
              abortCurrent()
              return result("reviewer-failure", "Review cancelled or expired.", false)
            }
            if (active.record)
              return result("reviewer-failure", "Review cancelled or expired.", false)
            if (error instanceof DecisionsTransportError) active.requestSent ||= error.requestSent
            const failure = classifyFailure(error, nativeModel(model))
            structuralSeen ||= failure.category === "invalid-decision"
            addRecord(active, failure.outcome, failure.httpStatus)
            lastCategory = failure.category
            lastReason = failure.reason
            operationalSeen ||= failure.operational

            if (failure.action === "stop") return result(lastCategory, lastReason)
            if (failure.action === "next-model") {
              moveToNextModel = true
              break
            }
            if (attemptIndex < attemptsPerModel) {
              const delayMs = Math.min(2_000, 400 * 2 ** (attemptIndex - 1))
              try {
                await attempt.wait(backoff(delayMs, attempt.signal))
              } catch {
                if (!attempt.active())
                  return result("reviewer-failure", "Review cancelled or expired.", false)
                return result("reviewer-failure", "Decisions retry was interrupted.")
              }
            }
            continue
          }

          const parsed = parseSystemOneReview(
            response,
            { ...options.config, model },
            {
              identityMode: "decisions",
            },
          )
          if (parsed) {
            addRecord(active, "selected", undefined, parsed.returnedModel)
            return {
              kind: "selected",
              model,
              parsed,
              attempts: trace.attempts.slice(0, MAX_TRACE_RECORDS),
            }
          }

          structuralSeen = true
          lastCategory = "invalid-decision"
          lastReason = "Decisions response was missing, invalid, or ambiguous."
          addRecord(active, "invalid-decision")
          if (attemptIndex < attemptsPerModel) {
            const delayMs = Math.min(2_000, 400 * 2 ** (attemptIndex - 1))
            try {
              await attempt.wait(backoff(delayMs, attempt.signal))
            } catch {
              if (!attempt.active())
                return result("reviewer-failure", "Review cancelled or expired.", false)
              return result("reviewer-failure", "Decisions retry was interrupted.")
            }
          }
        }
        current = undefined
        if (!moveToNextModel && !attempt.active()) {
          return result("reviewer-failure", "Review cancelled or expired.", false)
        }
      }
      return result(lastCategory, lastReason)
    } finally {
      current = undefined
      removeAbortListener()
    }
  }
}
