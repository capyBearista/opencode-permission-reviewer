import { DEFAULT_CONFIG } from "../src/config.ts"
import type { PermissionRequest, ReviewDecision, ReviewerConfig } from "../src/types.ts"

export function decision(
  outcome: ReviewDecision["outcome"],
  overrides: Partial<ReviewDecision> = {},
): ReviewDecision {
  return {
    version: 2,
    outcome,
    risk_level: outcome === "deny" ? "high" : "low",
    user_authorization: outcome === "allow" ? "high" : "low",
    rationale:
      outcome === "allow"
        ? "The action is narrow, reversible, and explicitly requested."
        : "The action has unsafe unrequested effects.",
    confidence: 0.95,
    scope_alignment: "aligned",
    evidence_completeness: "sufficient",
    ...overrides,
  }
}

export function request(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id: "per_1",
    sessionID: "ses_main",
    permission: "bash",
    patterns: ["printf safe"],
    metadata: { command: "printf safe" },
    always: ["printf *"],
    tool: { messageID: "msg_1", callID: "call_1" },
    ...overrides,
  }
}

export function config(overrides: Partial<ReviewerConfig> = {}): ReviewerConfig {
  return { ...DEFAULT_CONFIG, ...overrides }
}
