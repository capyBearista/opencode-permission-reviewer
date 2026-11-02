import type {
  ActorProfile,
  CapabilityActionClass,
  EscalationMode,
  PolicyCondition,
  PolicyRule,
  RiskPolicy,
  RepositoryTrust,
  ReviewerConfig,
  EscalationReviewerConfig,
  UserAuthorization,
} from "./types.ts"

/** Default risk×authorization matrix. Reproduces exactly the previous
 *  hard-coded gate: critical never auto-allows; high needs at least medium auth;
 *  medium needs at least low auth; low allows any auth including unknown. */
export const DEFAULT_RISK_POLICY: RiskPolicy = {
  allow: {
    low: ["high", "medium", "low", "unknown"],
    medium: ["high", "medium", "low"],
    high: ["high", "medium"],
    critical: [],
  },
  minimumConfidence: 0.7,
  onInvalidDecision: "manual",
  onReviewerFailure: "manual",
}

export const DEFAULT_CONFIG: ReviewerConfig = {
  model: "openai/gpt-6-luna",
  variant: "medium",
  outputFormat: "json_schema",
  timeoutMs: 120_000,
  maxContextChars: 32_000,
  maxPartChars: 8_000,
  maxEnrichmentChars: 24_000,
  maxIntentChars: 8_000,
  transcriptMessages: 12,
  intentMessages: 8,
  historyMessages: 200,
  confidenceThreshold: 0.7,
  systemOneConfidenceThreshold: 0.4,
  systemOneReasoningThreshold: 0.38,
  retainReviewSessions: false,
  audit: true,
  debug: false,
  enforcementMode: "observe",
  escalationMode: "manual",
  maxSessionDepth: 8,
  maxParentSessions: 8,
  actorProfiles: {},
  riskPolicy: DEFAULT_RISK_POLICY,
  repositoryTrust: "unknown",
  policyRules: [],
  askDecisions: true,
}

export const DEFAULT_DECISION_MODELS = ["opencode/jev-1.13-free"] as const
export const DEFAULT_REASONING_MODELS: readonly EscalationReviewerConfig[] = [
  {
    model: "openai/gpt-6-luna",
    variant: "medium",
    outputFormat: "json_schema",
    timeoutMs: 120_000,
  },
]
export const DEFAULT_DECISION_MAX_ATTEMPTS = 2
export const DEFAULT_DECISION_ATTEMPT_TIMEOUT_MS = 10_000

const DECISION_MODEL_MAX_COUNT = 8
const REASONING_MODEL_MAX_COUNT = 8
const OPENROUTER_DECISION_MODEL =
  /^openrouter\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/
const OPENROUTER_REASONING_MODEL =
  /^openrouter\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const GENERIC_REASONING_MODEL =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

/** Total deadline for a review, shared by the server and TUI watchdog. */
export function reviewBudgetMs(config: ReviewerConfig): number {
  return config.reviewBudgetMs ?? config.timeoutMs * 2 + 60_000
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

const ACTOR_PROFILES: ReadonlySet<ActorProfile> = new Set([
  "read-only",
  "validation",
  "workspace",
  "operator",
  "reviewer",
  "unknown",
])

/** Every action class the capability analyzer can produce. The `satisfies`
 *  clause keeps this list in sync with the union type: adding a member to
 *  `CapabilityActionClass` without listing it here is a compile error. */
const ACTION_CLASS_MEMBERS = {
  "read-only": true,
  "workspace-write": true,
  "temporary-write": true,
  "external-write": true,
  destruction: true,
  "code-execution": true,
  "package-management": true,
  "git-mutation": true,
  network: true,
  "remote-operation": true,
  "service-management": true,
  persistence: true,
  "privilege-escalation": true,
  unknown: true,
} satisfies Record<CapabilityActionClass, true>

const VALID_ACTION_CLASS: ReadonlySet<string> = new Set(Object.keys(ACTION_CLASS_MEMBERS))

const VALID_REPOSITORY_TRUST: ReadonlySet<string> = new Set(["trusted", "untrusted", "unknown"])

/** Parse a trusted name→profile mapping. Invalid entries are dropped. */
function resolveActorProfiles(value: unknown): Record<string, ActorProfile> {
  if (typeof value !== "object" || value === null) return {}
  const out: Record<string, ActorProfile> = {}
  for (const [name, profile] of Object.entries(value as Record<string, unknown>)) {
    if (typeof profile === "string" && ACTOR_PROFILES.has(profile as ActorProfile)) {
      out[name] = profile as ActorProfile
    }
  }
  return out
}

const VALID_AUTH = new Set(["high", "medium", "low", "unknown"])

/** Parse a risk×authorization matrix. Invalid or partial entries fall back to
 *  the conservative default. Failure-mode knobs only accept the stricter
 *  `"deny"` override; anything else keeps the default `"manual"`. */
function resolveRiskPolicy(value: unknown): RiskPolicy {
  if (typeof value !== "object" || value === null)
    return { ...DEFAULT_RISK_POLICY, allow: { ...DEFAULT_RISK_POLICY.allow } }
  const src = value as Record<string, unknown>
  const allowSrc = typeof src.allow === "object" && src.allow !== null ? src.allow : {}
  const merged: RiskPolicy = {
    allow: { ...DEFAULT_RISK_POLICY.allow },
    minimumConfidence: DEFAULT_RISK_POLICY.minimumConfidence,
    // Prefer an explicit deny from either the field or a pre-clamped trusted
    // baseline (loader may have already hardened the knob).
    onInvalidDecision:
      src.onInvalidDecision === "deny" ? "deny" : DEFAULT_RISK_POLICY.onInvalidDecision,
    onReviewerFailure:
      src.onReviewerFailure === "deny" ? "deny" : DEFAULT_RISK_POLICY.onReviewerFailure,
  }
  for (const risk of ["low", "medium", "high", "critical"] as const) {
    const cell = (allowSrc as Record<string, unknown>)[risk]
    if (!Array.isArray(cell)) continue
    const auths = cell.filter(
      (a) => typeof a === "string" && VALID_AUTH.has(a),
    ) as UserAuthorization[]
    merged.allow[risk] = auths
  }
  if (typeof src.minimumConfidence === "number" && Number.isFinite(src.minimumConfidence)) {
    merged.minimumConfidence = Math.min(1, Math.max(0.5, src.minimumConfidence))
  }
  return merged
}

function resolveEscalationMode(value: unknown): EscalationMode {
  return value === "deny" ? "deny" : "manual"
}

function resolveRepositoryTrust(value: unknown): RepositoryTrust {
  if (value === "trusted") return "trusted"
  if (value === "untrusted") return "untrusted"
  return "unknown"
}

const VALID_EFFECTS = new Set(["review", "manual", "deny", "allow"])
const VALID_SOURCES = new Set(["builtin", "global", "project", "inline"])

/** Parse one declarative policy rule. Malformed entries return null so the
 *  caller decides whether dropping them is safe (untrusted layer) or must
 *  degrade the config (trusted layer — a dropped restriction may be the whole
 *  point of the rule). A missing `when` is a valid universal rule. */
function parsePolicyRule(raw: unknown): PolicyRule | null {
  if (typeof raw !== "object" || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== "string" || r.id.length === 0) return null
  if (typeof r.source !== "string" || !VALID_SOURCES.has(r.source)) return null
  if (typeof r.effect !== "string" || !VALID_EFFECTS.has(r.effect)) return null
  if (typeof r.reason !== "string" || r.reason.length === 0) return null
  if (r.when !== undefined) {
    if (typeof r.when !== "object" || r.when === null) return null
    const when = validateCondition(r.when as Record<string, unknown>)
    if (when === null) return null
    return {
      id: r.id,
      source: r.source as PolicyRule["source"],
      when,
      effect: r.effect as PolicyRule["effect"],
      reason: r.reason,
    }
  }
  // No `when` at all: a universal rule. `{ always: true }` is the explicit
  // spelling of the same thing for admins who prefer it.
  return {
    id: r.id,
    source: r.source as PolicyRule["source"],
    effect: r.effect as PolicyRule["effect"],
    reason: r.reason,
  }
}

/** Parse declarative policy rules. Malformed entries are dropped. */
function resolvePolicyRules(value: unknown): PolicyRule[] {
  if (!Array.isArray(value)) return []
  const out: PolicyRule[] = []
  for (const raw of value) {
    const rule = parsePolicyRule(raw)
    if (rule !== null) out.push(rule)
  }
  return out
}

/** How many entries a policyRules array would silently drop under
 *  `resolvePolicyRules`. Trusted layers use this to refuse silent degradation:
 *  an admin rule that vanishes on a typo must block auto-approval, not just
 *  disappear. */
export function countInvalidPolicyRules(value: unknown): number {
  if (value === undefined) return 0
  if (!Array.isArray(value)) return 1
  return value.filter((raw) => parsePolicyRule(raw) === null).length
}
/** Validate a policy condition's sub-fields; return null if malformed (so a bad
 *  rule is dropped rather than crashing the engine at match time). */
const CONDITION_LIST_KEYS = ["actionClass", "actorProfile", "repositoryTrust"] as const
const CONDITION_FLAG_KEYS = [
  "writesWorkspace",
  "writesExternal",
  "writesTemporary",
  "deletion",
  "executesCode",
  "createsAdHocCode",
  "packageManagement",
  "gitMutation",
  "networkObserved",
  "credentialRead",
  "privilegeEscalation",
  "remoteEnabled",
  "persistence",
] as const

function validateCondition(value: Record<string, unknown>): PolicyCondition | null {
  // An unknown key (usually a typo) must drop the rule: silently discarding it
  // could strip the rule's only condition and turn a narrow rule into a
  // universal match.
  const knownKeys = new Set<string>(["always", ...CONDITION_LIST_KEYS, ...CONDITION_FLAG_KEYS])
  for (const key of Object.keys(value)) {
    if (!knownKeys.has(key)) return null
  }
  // `always` is the explicit catch-all spelling; it makes sense only alone.
  if (value.always !== undefined) {
    if (value.always !== true || Object.keys(value).length !== 1) return null
    return { always: true }
  }
  const out: Record<string, unknown> = {}
  // List conditions are matched with `includes()` at match time, so a member
  // outside the closed set (usually a typo) would never match and would
  // silently disable the rule. Rejecting it drops the rule through the normal
  // path, which degrades trusted configs fail-closed instead of losing a
  // restriction quietly. Empty lists never match either, so they are rejected
  // for the same reason.
  if (value.actionClass !== undefined) {
    if (!isClosedSetMemberArray(value.actionClass, VALID_ACTION_CLASS)) return null
    out.actionClass = value.actionClass
  }
  if (value.actorProfile !== undefined) {
    if (!isClosedSetMemberArray(value.actorProfile, ACTOR_PROFILES as ReadonlySet<string>))
      return null
    out.actorProfile = value.actorProfile
  }
  if (value.repositoryTrust !== undefined) {
    if (!isClosedSetMemberArray(value.repositoryTrust, VALID_REPOSITORY_TRUST)) return null
    out.repositoryTrust = value.repositoryTrust
  }
  for (const flag of CONDITION_FLAG_KEYS) {
    if (value[flag] !== undefined) {
      if (typeof value[flag] !== "boolean") return null
      // Capability facts are `true | "unknown"` — never false — so a `false`
      // condition could never match. Reject it instead of ignoring the filter:
      // an ignored condition widens the rule.
      if (value[flag] === false) return null
      out[flag] = value[flag]
    }
  }
  // A condition that validated to nothing would match every request while
  // LOOKING conditioned; catch-alls must be spelled unambiguously (omit `when`
  // entirely, or `{ always: true }`).
  if (Object.keys(out).length === 0) return null
  return out as PolicyCondition
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string")
}

/** A non-empty string array whose members all belong to the closed set. */
function isClosedSetMemberArray(value: unknown, valid: ReadonlySet<string>): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => typeof v === "string" && valid.has(v))
  )
}

export function resolveConfig(options: Record<string, unknown> | undefined): ReviewerConfig {
  const source = options ?? {}
  // The reviewer model is chosen per attempt from decisionModels/reasoningModels.
  const model = DEFAULT_CONFIG.model
  const variant =
    typeof source.variant === "string" && source.variant.length > 0
      ? source.variant
      : DEFAULT_CONFIG.variant
  const outputFormat = source.outputFormat === "text" ? "text" : "json_schema"
  const policy =
    typeof source.policy === "string" && source.policy.trim().length > 0
      ? source.policy.trim()
      : undefined
  const auditPath =
    typeof source.auditPath === "string" && source.auditPath.trim().length > 0
      ? source.auditPath.trim()
      : undefined

  return {
    model,
    variant,
    outputFormat,
    ...resolveDecisionRoutingConfig(source),
    timeoutMs: boundedInteger(source.timeoutMs, DEFAULT_CONFIG.timeoutMs, 5_000, 600_000),
    ...(source.reviewBudgetMs === undefined
      ? {}
      : { reviewBudgetMs: boundedInteger(source.reviewBudgetMs, 180_000, 5_000, 900_000) }),
    maxContextChars: boundedInteger(
      source.maxContextChars,
      DEFAULT_CONFIG.maxContextChars,
      4_000,
      200_000,
    ),
    maxPartChars: boundedInteger(source.maxPartChars, DEFAULT_CONFIG.maxPartChars, 500, 50_000),
    maxEnrichmentChars: boundedInteger(
      source.maxEnrichmentChars,
      DEFAULT_CONFIG.maxEnrichmentChars,
      1_000,
      100_000,
    ),
    maxIntentChars: boundedInteger(
      source.maxIntentChars,
      DEFAULT_CONFIG.maxIntentChars,
      1_000,
      50_000,
    ),
    transcriptMessages: boundedInteger(
      source.transcriptMessages,
      DEFAULT_CONFIG.transcriptMessages,
      1,
      100,
    ),
    intentMessages: boundedInteger(source.intentMessages, DEFAULT_CONFIG.intentMessages, 1, 50),
    historyMessages: boundedInteger(
      source.historyMessages,
      DEFAULT_CONFIG.historyMessages,
      20,
      500,
    ),
    confidenceThreshold: boundedNumber(
      source.confidenceThreshold,
      DEFAULT_CONFIG.confidenceThreshold,
      0.5,
      1,
    ),
    systemOneConfidenceThreshold: boundedNumber(
      source.systemOneConfidenceThreshold,
      DEFAULT_CONFIG.systemOneConfidenceThreshold,
      0.3,
      1,
    ),
    systemOneReasoningThreshold: boundedNumber(
      source.systemOneReasoningThreshold,
      DEFAULT_CONFIG.systemOneReasoningThreshold,
      0,
      1,
    ),
    retainReviewSessions:
      typeof source.retainReviewSessions === "boolean"
        ? source.retainReviewSessions
        : DEFAULT_CONFIG.retainReviewSessions,
    audit: typeof source.audit === "boolean" ? source.audit : DEFAULT_CONFIG.audit,
    ...(auditPath === undefined ? {} : { auditPath }),
    ...(policy === undefined ? {} : { policy }),
    debug: typeof source.debug === "boolean" ? source.debug : DEFAULT_CONFIG.debug,
    enforcementMode:
      source.enforcementMode === "enforce" ? "enforce" : DEFAULT_CONFIG.enforcementMode,
    escalationMode: resolveEscalationMode(source.escalationMode),
    maxSessionDepth: boundedInteger(source.maxSessionDepth, DEFAULT_CONFIG.maxSessionDepth, 1, 32),
    maxParentSessions: boundedInteger(
      source.maxParentSessions,
      DEFAULT_CONFIG.maxParentSessions,
      0,
      32,
    ),
    actorProfiles: resolveActorProfiles(source.actorProfiles),
    riskPolicy: resolveRiskPolicy(source.riskPolicy),
    repositoryTrust: resolveRepositoryTrust(source.repositoryTrust),
    policyRules: resolvePolicyRules(source.policyRules),
    askDecisions:
      typeof source.askDecisions === "boolean" ? source.askDecisions : DEFAULT_CONFIG.askDecisions,
    ...(isStringArray(source.configDegraded) && source.configDegraded.length > 0
      ? { configDegraded: source.configDegraded }
      : {}),
  }
}

/** Decision routes are intentionally generic within the bounded OpenRouter
 *  publisher/model namespace; Zen is limited to its free Jev model. */
export function isValidDecisionsModel(value: unknown): value is string {
  return (
    value === "opencode/jev-1.13-free" ||
    (typeof value === "string" && OPENROUTER_DECISION_MODEL.test(value))
  )
}

export function isValidDecisionModels(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= DECISION_MODEL_MAX_COUNT &&
    value.every(isValidDecisionsModel) &&
    new Set(value).size === value.length
  )
}

/** Validate an entire reasoning route array. A single invalid entry invalidates
 *  the complete trusted array rather than silently shifting its active route. */
export function isValidReasoningModels(value: unknown): boolean {
  if (!Array.isArray(value) || value.length < 1 || value.length > REASONING_MODEL_MAX_COUNT) {
    return false
  }
  const models = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false
    const source = entry as Record<string, unknown>
    if (
      Object.keys(source).some(
        (key) => !["model", "variant", "outputFormat", "timeoutMs"].includes(key),
      )
    )
      return false
    if (typeof source.model !== "string" || !isValidReasoningModel(source.model)) return false
    if (models.has(source.model)) return false
    models.add(source.model)
    if (
      source.variant !== undefined &&
      (typeof source.variant !== "string" ||
        source.variant.length === 0 ||
        source.variant.length > 128 ||
        source.variant.split("").some((character) => {
          const code = character.charCodeAt(0)
          return code <= 0x1f || code === 0x7f
        }))
    ) {
      return false
    }
    if (
      source.outputFormat !== undefined &&
      source.outputFormat !== "json_schema" &&
      source.outputFormat !== "text"
    ) {
      return false
    }
    if (source.timeoutMs !== undefined && !isBoundedInteger(source.timeoutMs, 5_000, 600_000)) {
      return false
    }
  }
  return true
}

export function isValidDecisionMaxAttempts(value: unknown): value is number {
  return isBoundedInteger(value, 1, 5)
}

export function isValidDecisionAttemptTimeoutMs(value: unknown): value is number {
  return isBoundedInteger(value, 1_000, 60_000)
}

function isBoundedInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
}

function isValidReasoningModel(model: string): boolean {
  if (model.length > 256) return false
  const validSyntax = model.startsWith("openrouter/")
    ? OPENROUTER_REASONING_MODEL.test(model)
    : GENERIC_REASONING_MODEL.test(model)
  return validSyntax && !isSystemOneReviewerModel(model)
}

function resolveDecisionRoutingConfig(
  source: Record<string, unknown>,
): Pick<
  ReviewerConfig,
  "decisionModels" | "reasoningModels" | "decisionMaxAttempts" | "decisionAttemptTimeoutMs"
> {
  const reasoningModels =
    source.reasoningModels === undefined
      ? DEFAULT_REASONING_MODELS.map((entry) => ({ ...entry }))
      : isValidReasoningModels(source.reasoningModels)
        ? (source.reasoningModels as Array<Record<string, unknown>>).map((entry) => ({
            model: entry.model as string,
            variant: (entry.variant as string | undefined) ?? DEFAULT_CONFIG.variant,
            outputFormat:
              (entry.outputFormat as ReviewerConfig["outputFormat"] | undefined) ??
              DEFAULT_CONFIG.outputFormat,
            timeoutMs: (entry.timeoutMs as number | undefined) ?? DEFAULT_CONFIG.timeoutMs,
          }))
        : []

  return {
    decisionModels:
      source.decisionModels === undefined
        ? [...DEFAULT_DECISION_MODELS]
        : isValidDecisionModels(source.decisionModels)
          ? [...source.decisionModels]
          : [],
    reasoningModels,
    decisionMaxAttempts: isValidDecisionMaxAttempts(source.decisionMaxAttempts)
      ? source.decisionMaxAttempts
      : DEFAULT_DECISION_MAX_ATTEMPTS,
    decisionAttemptTimeoutMs: isValidDecisionAttemptTimeoutMs(source.decisionAttemptTimeoutMs)
      ? source.decisionAttemptTimeoutMs
      : DEFAULT_DECISION_ATTEMPT_TIMEOUT_MS,
  }
}

export function splitModel(model: string): { providerID: string; modelID: string } {
  const slash = model.indexOf("/")
  if (slash <= 0 || slash === model.length - 1) {
    throw new Error(`Invalid reviewer model "${model}"; expected provider/model`)
  }
  return {
    providerID: model.slice(0, slash),
    modelID: model.slice(slash + 1),
  }
}

export function isSystemOneReviewerModel(model: string): boolean {
  let parsed: { providerID: string; modelID: string }
  try {
    parsed = splitModel(model)
  } catch {
    return false
  }
  // Jev uses the typed System One API rather than a chat-session transport.
  return (
    ((parsed.providerID === "opencode" || parsed.providerID === "typesafe-ai") &&
      /^jev(?:-|$)/.test(parsed.modelID)) ||
    (parsed.providerID === "commandcode" && parsed.modelID === "typesafe/jev")
  )
}
