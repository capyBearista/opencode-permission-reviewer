import { mkdir } from "node:fs/promises"
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, resolve } from "node:path"
import type {
  DecisionAttempt,
  DecisionRoutingTrace,
  ReviewAuditRecord,
  ReviewerConfig,
} from "./types.ts"
import { redactSecrets } from "./redact.ts"

export const DEFAULT_AUDIT_PATH = "~/.local/share/opencode/permission-reviewer-audit.jsonl"

const DECISION_ATTEMPT_OUTCOMES: ReadonlySet<string> = new Set([
  "valid-decision",
  "invalid-decision",
  "network-error",
  "timeout",
  "internal-error",
  "http-error",
  "missing-credentials",
  "cancelled",
  "deadline",
])
const SAFE_MODEL_ID =
  /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}|openrouter\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/
const SAFE_RESPONSE_MODEL_ID =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127})?(?:-\d{8})?$/
const MAX_DECISION_ATTEMPTS = 40

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isSafeResponseModel(value: unknown): value is string {
  return typeof value === "string" && value.length <= 202 && SAFE_RESPONSE_MODEL_ID.test(value)
}

function sanitizeDecisionAttempts(
  config: ReviewerConfig,
  value: unknown,
): DecisionAttempt[] | undefined {
  if (!Array.isArray(value) || !Array.isArray(config.decisionModels)) return
  const sanitized: DecisionAttempt[] = []
  for (const candidate of value.slice(0, MAX_DECISION_ATTEMPTS)) {
    if (!isRecord(candidate)) continue
    const modelIndex = candidate.modelIndex
    const model = candidate.model
    const attempt = candidate.attempt
    const durationMs = candidate.durationMs
    if (
      typeof modelIndex !== "number" ||
      !Number.isInteger(modelIndex) ||
      modelIndex < 0 ||
      modelIndex > 7 ||
      modelIndex >= config.decisionModels.length ||
      typeof model !== "string" ||
      !SAFE_MODEL_ID.test(model) ||
      model !== config.decisionModels[modelIndex] ||
      typeof attempt !== "number" ||
      !Number.isInteger(attempt) ||
      attempt < 1 ||
      attempt > 5 ||
      typeof candidate.requestSent !== "boolean" ||
      typeof candidate.outcome !== "string" ||
      !DECISION_ATTEMPT_OUTCOMES.has(candidate.outcome) ||
      typeof durationMs !== "number" ||
      !Number.isFinite(durationMs) ||
      durationMs < 0
    ) {
      continue
    }
    const outcome = candidate.outcome as DecisionAttempt["outcome"]
    const responseModel =
      outcome === "valid-decision" && isSafeResponseModel(candidate.responseModel)
        ? candidate.responseModel
        : undefined
    const httpStatus =
      typeof candidate.httpStatus === "number" &&
      Number.isInteger(candidate.httpStatus) &&
      candidate.httpStatus >= 100 &&
      candidate.httpStatus <= 599
        ? candidate.httpStatus
        : undefined
    sanitized.push({
      model,
      modelIndex,
      attempt,
      requestSent: candidate.requestSent,
      outcome,
      durationMs: Math.min(60_000, durationMs),
      ...(httpStatus === undefined ? {} : { httpStatus }),
      ...(responseModel === undefined ? {} : { responseModel }),
    })
  }
  return sanitized
}

/** Copy only configured V2 route attribution and its bounded closed attempt history. */
export function sanitizeDecisionMetadata(
  config: ReviewerConfig,
  trace:
    | Pick<
        DecisionRoutingTrace,
        "attempts" | "reviewerModel" | "reviewerEscalatedFrom" | "responseModel"
      >
    | undefined,
  fallback?: Pick<
    ReviewAuditRecord,
    "reviewerModel" | "reviewerEscalatedFrom" | "responseModel" | "decisionAttempts"
  >,
): Pick<
  ReviewAuditRecord,
  "decisionAttempts" | "reviewerModel" | "reviewerEscalatedFrom" | "responseModel"
> {
  if (!Array.isArray(config.decisionModels)) return {}
  const attempts = sanitizeDecisionAttempts(
    config,
    trace === undefined ? fallback?.decisionAttempts : trace.attempts,
  )
  const reviewerModel = trace === undefined ? fallback?.reviewerModel : trace.reviewerModel
  const provenance =
    trace === undefined ? fallback?.reviewerEscalatedFrom : trace.reviewerEscalatedFrom
  const safeProvenance =
    isRecord(provenance) &&
    typeof provenance.model === "string" &&
    SAFE_MODEL_ID.test(provenance.model) &&
    config.decisionModels.includes(provenance.model) &&
    attempts?.some(
      (attempt) => attempt.model === provenance.model && attempt.outcome === "valid-decision",
    ) &&
    typeof provenance.reason === "string"
      ? {
          model: provenance.model,
          reason: redactSecrets(boundedReason(provenance.reason)),
        }
      : undefined
  const configuredReviewerModels = new Set([
    ...config.decisionModels,
    ...(config.reasoningModels ?? []).map((entry) => entry.model),
  ])
  const safeReviewerModel =
    typeof reviewerModel === "string" &&
    SAFE_MODEL_ID.test(reviewerModel) &&
    configuredReviewerModels.has(reviewerModel) &&
    ((config.decisionModels.includes(reviewerModel) &&
      attempts?.some(
        (attempt) => attempt.model === reviewerModel && attempt.outcome === "valid-decision",
      )) ||
      ((config.reasoningModels ?? []).some((entry) => entry.model === reviewerModel) &&
        safeProvenance !== undefined))
      ? reviewerModel
      : undefined
  const responseModel = trace === undefined ? fallback?.responseModel : trace.responseModel
  const safeResponseModel =
    isSafeResponseModel(responseModel) &&
    attempts?.some(
      (attempt) =>
        attempt.outcome === "valid-decision" &&
        attempt.responseModel === responseModel &&
        config.decisionModels?.[attempt.modelIndex] === attempt.model,
    )
      ? responseModel
      : undefined
  const safeReviewerEscalatedFrom =
    safeReviewerModel !== undefined &&
    (config.reasoningModels ?? []).some((entry) => entry.model === safeReviewerModel)
      ? safeProvenance
      : undefined
  return {
    ...(attempts === undefined ? {} : { decisionAttempts: attempts }),
    ...(safeReviewerModel === undefined ? {} : { reviewerModel: safeReviewerModel }),
    ...(safeReviewerEscalatedFrom === undefined
      ? {}
      : { reviewerEscalatedFrom: safeReviewerEscalatedFrom }),
    ...(safeResponseModel === undefined ? {} : { responseModel: safeResponseModel }),
  }
}

function withoutDecisionMetadata(record: ReviewAuditRecord): ReviewAuditRecord {
  const copy = { ...record }
  delete copy.decisionAttempts
  delete copy.reviewerModel
  delete copy.reviewerEscalatedFrom
  delete copy.responseModel
  return copy
}

const O_RDONLY = typeof fsConstants.O_RDONLY === "number" ? fsConstants.O_RDONLY : 0
const O_WRONLY = typeof fsConstants.O_WRONLY === "number" ? fsConstants.O_WRONLY : 0
const O_CREAT = typeof fsConstants.O_CREAT === "number" ? fsConstants.O_CREAT : 0
const O_APPEND = typeof fsConstants.O_APPEND === "number" ? fsConstants.O_APPEND : 0
const O_NOFOLLOW = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0
const O_NONBLOCK = typeof fsConstants.O_NONBLOCK === "number" ? fsConstants.O_NONBLOCK : 0

export function expandHome(path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2))
  return resolve(path)
}

/** Resolve the audit path the way the writer does. */
export function resolveAuditPath(config: ReviewerConfig): string {
  return expandHome(config.auditPath ?? DEFAULT_AUDIT_PATH)
}

/** The required identity/decision fields every audit record must carry. Used
 *  by the report reader to flag truncated or malformed lines. */
const REQUIRED_AUDIT_FIELDS = [
  "timestamp",
  "requestID",
  "sessionID",
  "permission",
  "outcome",
  "reason",
] as const

export interface AuditMissingFields {
  lineNo: number
  missing: string[]
}

export interface AuditSummary {
  path: string
  exists: boolean
  /** True when only the bounded tail (most recent 64 MiB) was summarized:
   *  line counts and timestamps then describe that window, not the file. */
  truncated: boolean
  totalLines: number
  validRecords: number
  invalidLines: number
  bySchemaVersion: Record<string, number>
  byHostGeneration: Record<string, number>
  byApplication: Record<string, number>
  byOutcome: Record<string, number>
  byRiskLevel: Record<string, number>
  byDecisionSource: Record<string, number>
  byPermission: Record<string, number>
  unknownActorNames: Array<{ name: string; count: number }>
  missingRequiredFields: AuditMissingFields[]
  firstTimestamp?: string
  lastTimestamp?: string
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1
}

/** Cap on how much of an audit file the summary reader will pull into memory:
 *  the file is append-only and grows without bound, and the report only needs
 *  the most recent records. When the cap is hit the reader summarizes the tail
 *  (newest records) and flags the truncation. */
const AUDIT_READ_CAP_BYTES = 64 * 1024 * 1024

/** Read the (bounded) tail of an audit file synchronously without loading the
 *  whole file. The size and the bytes both come from the open descriptor, so
 *  the window matches the data actually read. Never throws: any failure to
 *  open/stat/read returns undefined and the caller reports the file as
 *  unreadable. */
function readTail(path: string): { text: string; truncated: boolean } | undefined {
  let fd: number | undefined
  try {
    // O_NOFOLLOW rejects a symlinked audit path and O_NONBLOCK keeps a FIFO
    // from blocking the CLI before fstat can reject the non-regular file.
    fd = openSync(path, O_RDONLY | O_NONBLOCK | O_NOFOLLOW)
    const info = fstatSync(fd)
    if (!info.isFile()) return undefined
    const size = info.size
    const truncated = size > AUDIT_READ_CAP_BYTES
    const length = truncated ? AUDIT_READ_CAP_BYTES : size
    const buffer = Buffer.alloc(length)
    const offset = truncated ? size - length : 0
    // When the window does not start at the beginning of the file, its first
    // byte may land mid-line. Peek at the byte just before the window: a
    // newline there means the window already starts at a line boundary, so
    // the first line is whole and must be kept. Otherwise the first line may
    // be partial and is dropped below. A failed peek keeps the old
    // always-strip behavior; it only ever drops one line from the report.
    let atLineBoundary = false
    if (truncated && offset > 0) {
      try {
        const probe = Buffer.alloc(1)
        const seen = readSync(fd, probe, 0, 1, offset - 1)
        atLineBoundary = seen === 1 && probe[0] === 0x0a
      } catch {
        atLineBoundary = false
      }
    }
    let read = 0
    while (read < length) {
      const count = readSync(fd, buffer, read, length - read, offset + read)
      if (count === 0) break
      read += count
    }
    // A shrink after fstat can end the read early; decode only the bytes
    // actually read so no zero-padding leaks into the text.
    let text = (read < length ? buffer.subarray(0, read) : buffer).toString("utf8")
    if (truncated && !atLineBoundary) {
      // Drop a possibly partial first line so every summarized line is whole.
      text = text.replace(/^[^\n]*\n/, "")
    }
    return { text, truncated }
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSyncSafe(fd)
  }
}

function closeSyncSafe(fd: number): void {
  try {
    closeSync(fd)
  } catch {
    // Best effort; the read already succeeded or failed on its own.
  }
}

/** Read an append-only JSONL audit file and summarize it. Never throws: a
 *  missing/unreadable file returns an empty summary with `exists: false`, and
 *  malformed records (wrong shapes, null actors, bad JSON) are counted as
 *  invalid lines instead of aborting the report. */
export function readAuditSummary(path: string): AuditSummary {
  const summary: AuditSummary = {
    path,
    exists: false,
    truncated: false,
    totalLines: 0,
    validRecords: 0,
    invalidLines: 0,
    bySchemaVersion: {},
    byHostGeneration: {},
    byApplication: {},
    byOutcome: {},
    byRiskLevel: {},
    byDecisionSource: {},
    byPermission: {},
    unknownActorNames: [],
    missingRequiredFields: [],
  }
  const read = readTail(path)
  if (read === undefined) return summary
  summary.exists = true
  summary.truncated = read.truncated
  const lines = read.text.split("\n").filter((line) => line.trim().length > 0)
  // When the cap was hit only the tail was read; line counts then describe
  // the summarized window, not the whole file.
  summary.totalLines = lines.length
  const actorCounts = new Map<string, number>()
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1
    let parsed: unknown
    try {
      parsed = JSON.parse(lines[i]!)
    } catch {
      summary.invalidLines++
      continue
    }
    // A bare primitive or null/array is not an audit record; count it as an
    // invalid line instead of throwing on the property accesses below.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      summary.invalidLines++
      continue
    }
    const record = parsed as Record<string, unknown>
    summary.validRecords++
    bump(summary.bySchemaVersion, String(record.schemaVersion ?? 1))
    bump(
      summary.byHostGeneration,
      record.hostGeneration === "v1" || record.hostGeneration === "v2"
        ? record.hostGeneration
        : "legacy-unspecified",
    )
    if (
      typeof record.application === "string" &&
      [
        "evaluation-returned",
        "reply-accepted",
        "human-pending",
        "superseded",
        "cancelled",
        "unknown",
      ].includes(record.application)
    )
      bump(summary.byApplication, record.application)
    if (typeof record.outcome === "string") bump(summary.byOutcome, record.outcome)
    bump(summary.byRiskLevel, typeof record.riskLevel === "string" ? record.riskLevel : "(none)")
    if (typeof record.decisionSource === "string")
      bump(summary.byDecisionSource, record.decisionSource)
    if (typeof record.permission === "string") bump(summary.byPermission, record.permission)
    if (typeof record.timestamp === "string") {
      if (summary.firstTimestamp === undefined || record.timestamp < summary.firstTimestamp) {
        summary.firstTimestamp = record.timestamp
      }
      if (summary.lastTimestamp === undefined || record.timestamp > summary.lastTimestamp) {
        summary.lastTimestamp = record.timestamp
      }
    }
    const missing = REQUIRED_AUDIT_FIELDS.filter((f) => record[f] === undefined)
    if (missing.length > 0) summary.missingRequiredFields.push({ lineNo, missing })
    const actor =
      typeof record.actor === "object" && record.actor !== null
        ? (record.actor as { name?: string; profile?: string })
        : undefined
    const isUnknown =
      actor === undefined ||
      actor.profile === undefined ||
      actor.profile === "unknown" ||
      actor.name === undefined ||
      actor.name === ""
    if (isUnknown) {
      const rawName = actor?.name ?? (record.actor === undefined ? "(no actor field)" : "(unnamed)")
      // A hostile or corrupted record can put anything in `name`; coerce to a
      // string before it reaches the localeCompare below.
      const name = typeof rawName === "string" ? rawName : JSON.stringify(rawName)
      actorCounts.set(name, (actorCounts.get(name) ?? 0) + 1)
    }
  }
  summary.unknownActorNames = [...actorCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return summary
}

function boundedReason(reason: string): string {
  const normalized = reason.replace(/[\r\n]+/g, " ").trim()
  return normalized.length <= 2_000 ? normalized : `${normalized.slice(0, 2_000)}…`
}

export function createAuditWriter(
  config: ReviewerConfig,
  logger?: (message: string, details?: unknown) => void,
): ((record: ReviewAuditRecord) => Promise<void>) | undefined {
  if (!config.audit) return
  const path = expandHome(config.auditPath ?? DEFAULT_AUDIT_PATH)
  let ready: Promise<void> | undefined
  return async (record) => {
    try {
      ready ??= mkdir(dirname(path), { recursive: true }).then(() => {})
      await ready
    } catch (error) {
      // The audit trail is best-effort: a directory that cannot be created
      // loses the record the same way an append failure does, logged and
      // never thrown. The cached promise is cleared so a later record retries
      // the mkdir instead of sticking to the rejection.
      logger?.("failed to append audit record", {
        path,
        error: error instanceof Error ? error.message : String(error),
      })
      ready = undefined
      return
    }
    // Redact the free-text fields (the reason carries transport error messages
    // and provider responses that never passed through the evidence
    // pipeline's redaction). Structural identifiers are left intact: running
    // the redactor over the whole serialized line would also match key names
    // like "sessionID" and corrupt the record's correlation fields.
    const decisionMetadata = sanitizeDecisionMetadata(config, undefined, record)
    const baseRecord =
      config.decisionModels === undefined ? record : withoutDecisionMetadata(record)
    const sanitized: ReviewAuditRecord = {
      ...baseRecord,
      ...(config.decisionModels === undefined
        ? {}
        : {
            ...(decisionMetadata.decisionAttempts === undefined
              ? {}
              : { decisionAttempts: decisionMetadata.decisionAttempts }),
            ...(decisionMetadata.reviewerModel === undefined
              ? {}
              : { reviewerModel: decisionMetadata.reviewerModel }),
            ...(decisionMetadata.reviewerEscalatedFrom === undefined
              ? {}
              : { reviewerEscalatedFrom: decisionMetadata.reviewerEscalatedFrom }),
            ...(decisionMetadata.responseModel === undefined
              ? {}
              : { responseModel: decisionMetadata.responseModel }),
          }),
      reason: redactSecrets(boundedReason(record.reason)),
      ...(record.fallbackReason === undefined
        ? {}
        : { fallbackReason: redactSecrets(boundedReason(record.fallbackReason)) }),
      ...(record.warnings === undefined
        ? {}
        : { warnings: record.warnings.map((warning) => redactSecrets(warning)) }),
      ...(record.policyTrace === undefined
        ? {}
        : {
            policyTrace: {
              ...record.policyTrace,
              // Rule reasons are admin-authored prose; redact them like any
              // other free text without touching the structural fields.
              matchedRules: record.policyTrace.matchedRules.map((match) => ({
                ...match,
                reason: redactSecrets(match.reason),
              })),
            },
          }),
      ...(record.askDecisions === undefined
        ? {}
        : {
            askDecisions: record.askDecisions.map((decision) => ({
              ...decision,
              question: redactSecrets(decision.question),
              answer: redactSecrets(decision.answer),
            })),
          }),
      ...(config.decisionModels === undefined
        ? record.reviewerEscalatedFrom === undefined
          ? {}
          : {
              reviewerEscalatedFrom: {
                ...record.reviewerEscalatedFrom,
                reason: redactSecrets(boundedReason(record.reviewerEscalatedFrom.reason)),
              },
            }
        : {}),
    }
    try {
      appendAuditLine(path, `${JSON.stringify(sanitized)}\n`)
    } catch (error) {
      // The audit trail is best-effort: a lost record is logged, never thrown.
      logger?.("failed to append audit record", {
        path,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

/** Append one JSONL line through an explicitly opened descriptor: O_NOFOLLOW
 *  rejects a symlinked audit path, O_NONBLOCK refuses to hang on a FIFO
 *  destination (a write-open on a readerless FIFO fails with ENXIO instead of
 *  blocking the host forever), the descriptor is verified to be a regular
 *  file before writing, and mode 0600 is asserted on every append — a
 *  pre-existing group- or world-readable audit file is tightened before it
 *  receives new records, matching the documented 0600 guarantee instead of
 *  silently extending a looser mode. If the mode cannot be enforced (for
 *  example a file owned by another user), the append fails rather than adding
 *  records to a readable file. One open per record matches the previous
 *  append-per-call behavior. Throws on failure; the caller logs and swallows. */
function appendAuditLine(path: string, line: string): void {
  let fd: number | undefined
  try {
    // One atomic open covers creation and append without a path check or retry.
    // The creation mode closes the umask window before the first record.
    fd = openSync(path, O_WRONLY | O_CREAT | O_APPEND | O_NOFOLLOW | O_NONBLOCK, 0o600)
    const info = fstatSync(fd)
    if (!info.isFile()) {
      throw new Error(`not a regular file: ${path}`)
    }
    try {
      // 0o7777 so setuid/setgid residue also counts as wrong.
      if ((info.mode & 0o7777) !== 0o600) fchmodSync(fd, 0o600)
    } catch (error) {
      throw new Error(
        `cannot enforce mode 0600 on the audit path (chmod 600 it or fix its ownership): ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      )
    }
    const data = Buffer.from(line, "utf8")
    let written = 0
    while (written < data.length) {
      const count = writeSync(fd, data, written, data.length - written)
      written += count
    }
  } finally {
    if (fd !== undefined) closeSyncSafe(fd)
  }
}
