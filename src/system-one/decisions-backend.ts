import type { OpenCodeClient } from "@opencode/client"
import type { ReviewAttempt } from "../core/review-attempt.ts"
import { buildEvidenceResult } from "../context.ts"
import { applyEscalationDisposition } from "../escalation.ts"
import { formatFailureReason } from "../failure-reason.ts"
import { DEFAULT_TENANT_POLICY, REVIEWER_SYSTEM_PROMPT } from "../policy.ts"
import { redactSecrets } from "../redact.ts"
import type {
  DecisionAttempt,
  DecisionAttemptOutcome,
  DecisionRoutingTrace,
  ReviewEnvelope,
  ReviewExecutionResult,
  ReviewerConfig,
} from "../types.ts"
import {
  createDecisionsRouter,
  type DecisionAttemptRecord,
  type DecisionsRouteTrace,
  type DecisionsSelection,
} from "./decisions-router.ts"
import type { DecisionsTransport } from "./decisions-transport.ts"
import { enforceParsedSystemOneReview, type SystemOneState } from "./review.ts"

export interface DecisionsReasoningReviewer {
  model: string
  review: (
    envelope: ReviewEnvelope,
    attempt: ReviewAttempt,
    client: OpenCodeClient,
  ) => Promise<ReviewExecutionResult>
}

export interface DecisionsReviewerBackendOptions {
  config: ReviewerConfig
  transport: DecisionsTransport
  reasoning?: DecisionsReasoningReviewer
}

function canonicalOutcome(outcome: DecisionAttemptRecord["outcome"]): DecisionAttemptOutcome {
  switch (outcome) {
    case "selected":
      return "valid-decision"
    case "invalid-decision":
      return "invalid-decision"
    case "network-error":
      return "network-error"
    case "timeout":
      return "timeout"
    case "cancelled":
      return "cancelled"
    case "deadline-exceeded":
      return "deadline"
    case "missing-credentials":
      return "missing-credentials"
    case "internal-error":
      return "internal-error"
    case "access-unavailable":
    case "endpoint-unavailable":
    case "model-not-found":
    case "model-rejected":
    case "http-retryable":
    case "invalid-request":
    case "unexpected-http-status":
      return "http-error"
  }
}

function canonicalAttempt(record: DecisionAttemptRecord): DecisionAttempt {
  return {
    model: record.model,
    modelIndex: record.modelIndex,
    attempt: record.attempt,
    requestSent: record.requestSent,
    outcome: canonicalOutcome(record.outcome),
    durationMs: record.durationMs,
    ...(record.httpStatus === undefined ? {} : { httpStatus: record.httpStatus }),
    ...(record.responseModel === undefined ? {} : { responseModel: record.responseModel }),
  }
}

/** Writes the router's richer local outcomes into the canonical envelope trace synchronously. */
class EnvelopeAttemptRecords extends Array<DecisionAttemptRecord> {
  /**
   * Keep species-derived copies (`slice`, `map`, ...) plain: they carry no
   * destination, so they must never inherit the mirroring `push`.
   */
  static get [Symbol.species](): ArrayConstructor {
    return Array
  }

  constructor(private readonly destination: DecisionRoutingTrace) {
    super()
  }

  override push(...records: DecisionAttemptRecord[]): number {
    const length = super.push(...records)
    this.destination.attempts.push(...records.map(canonicalAttempt))
    return length
  }
}

function resultWithTrace(
  result: ReviewExecutionResult,
  trace: DecisionRoutingTrace,
): ReviewExecutionResult {
  return {
    ...result,
    ...(trace.reviewerModel === undefined && result.reviewerModel === undefined
      ? {}
      : { reviewerModel: trace.reviewerModel ?? result.reviewerModel }),
    ...(trace.reviewerEscalatedFrom === undefined && result.reviewerEscalatedFrom === undefined
      ? {}
      : {
          reviewerEscalatedFrom: trace.reviewerEscalatedFrom ?? result.reviewerEscalatedFrom,
        }),
    decisionAttempts: trace.attempts.slice(0, 40),
    ...(trace.responseModel === undefined ? {} : { responseModel: trace.responseModel }),
  }
}

function reconcileReasoningResult(result: ReviewExecutionResult): ReviewExecutionResult {
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

function systemOneState(config: ReviewerConfig, envelope: ReviewEnvelope): SystemOneState {
  const evidence = buildEvidenceResult(envelope, config)
  envelope.actionEvidenceComplete =
    envelope.actionEvidenceComplete !== false && evidence.actionEvidenceComplete
  return {
    trustedPolicy: {
      reviewer: REVIEWER_SYSTEM_PROMPT,
      tenant: redactSecrets(config.policy ?? DEFAULT_TENANT_POLICY),
    },
    untrustedEvidence: evidence.text,
  }
}

export class DecisionsReviewerBackend {
  private readonly jobs = new Set<Promise<ReviewExecutionResult>>()
  private readonly route: (
    state: SystemOneState,
    attempt: ReviewAttempt,
    trace?: DecisionsRouteTrace,
  ) => Promise<DecisionsSelection>

  constructor(private readonly options: DecisionsReviewerBackendOptions) {
    this.route = createDecisionsRouter({
      config: options.config,
      models: options.config.decisionModels ?? [],
      transport: options.transport,
      ...(options.config.decisionMaxAttempts === undefined
        ? {}
        : { attemptsPerModel: options.config.decisionMaxAttempts }),
      ...(options.config.decisionAttemptTimeoutMs === undefined
        ? {}
        : { timeoutMs: options.config.decisionAttemptTimeoutMs }),
    })
  }

  review(
    envelope: ReviewEnvelope,
    attempt: ReviewAttempt,
    client: OpenCodeClient,
  ): Promise<ReviewExecutionResult> {
    const job = this.runReview(envelope, attempt, client).finally(() => this.jobs.delete(job))
    this.jobs.add(job)
    return job
  }

  async waitForIdle(): Promise<void> {
    await Promise.allSettled([...this.jobs])
  }

  private async runReview(
    envelope: ReviewEnvelope,
    attempt: ReviewAttempt,
    client: OpenCodeClient,
  ): Promise<ReviewExecutionResult> {
    const started = performance.now()
    const trace: DecisionRoutingTrace = { attempts: [] }
    envelope.decisionTrace = trace
    const routeTrace: DecisionsRouteTrace = {
      attempts: new EnvelopeAttemptRecords(trace),
    }

    try {
      const selection = await this.route(
        systemOneState(this.options.config, envelope),
        attempt,
        routeTrace,
      )
      if (selection.kind === "failed") {
        return resultWithTrace(
          applyEscalationDisposition(
            {
              kind: "escalate",
              reason: selection.reason,
              decisionSource: "failure-safe",
            },
            this.options.config,
            selection.category,
          ),
          trace,
        )
      }

      trace.reviewerModel = selection.model
      trace.responseModel = selection.parsed.returnedModel
      const enforced = enforceParsedSystemOneReview(selection.parsed, this.options.config)
      if (enforced.kind !== "escalate") {
        return resultWithTrace(
          {
            ...enforced,
            decisionSource: "system-one-reviewer",
            reviewerModel: selection.model,
          },
          trace,
        )
      }

      const reasoning = this.options.reasoning
      if (reasoning && selection.parsed.reasoningRecommended) {
        let reasoningResult: ReviewExecutionResult
        try {
          reasoningResult = await attempt.wait(reasoning.review(envelope, attempt, client))
        } catch (error) {
          reasoningResult = applyEscalationDisposition(
            {
              kind: "escalate",
              reason: formatFailureReason("reasoning reviewer", error),
              decisionSource: "failure-safe",
            },
            this.options.config,
            "reviewer-failure",
          )
        }
        const reconciled = reconcileReasoningResult(reasoningResult)
        const reasoningProducedDecision =
          reasoningResult.decision !== undefined &&
          reasoningResult.decisionSource !== "failure-safe" &&
          reconciled.kind !== "escalate"
        if (reasoningProducedDecision) {
          trace.reviewerModel = reasoning.model
          trace.reviewerEscalatedFrom = {
            model: selection.model,
            reason: enforced.reason,
          }
        }
        return resultWithTrace(
          {
            ...reconciled,
            reviewerModel: reasoningProducedDecision ? reasoning.model : selection.model,
            reviewerEscalatedFrom: { model: selection.model, reason: enforced.reason },
          },
          trace,
        )
      }

      return resultWithTrace(
        applyEscalationDisposition(
          {
            ...enforced,
            decisionSource: "system-one-reviewer",
            reviewerModel: selection.model,
          },
          this.options.config,
          "general",
        ),
        trace,
      )
    } catch (error) {
      return resultWithTrace(
        applyEscalationDisposition(
          {
            kind: "escalate",
            reason: formatFailureReason("Decisions reviewer", error),
            decisionSource: "failure-safe",
          },
          this.options.config,
          "reviewer-failure",
        ),
        trace,
      )
    } finally {
      envelope.timings = {
        ...envelope.timings,
        reviewerMs: performance.now() - started,
      }
    }
  }
}
