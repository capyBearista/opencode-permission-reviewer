import { setup } from "./opencode/v2/server.ts"

const module = {
  id: "opencode-permission-reviewer",
  setup,
}

export default module
export { resolveConfig } from "./config.ts"
export { loadResolvedConfig } from "./config/loader.ts"
export { parseDecision, enforceDecision, DECISION_SCHEMA } from "./decision.ts"
export { applyEscalationDisposition, resolveEscalationDisposition } from "./escalation.ts"
export { emergencyBrakeReason } from "./emergency-brake.ts"
export { redactSecrets } from "./redact.ts"
export { createUiStatus, decodeUiStatus, encodeUiStatus, permissionAction } from "./ui-protocol.ts"
export { ReviewUiState } from "./ui-state.ts"
export { createAuditWriter, DEFAULT_AUDIT_PATH } from "./audit.ts"
export { enrichSshEvidence } from "./ssh-evidence.ts"
export { enrichLocalScriptEvidence } from "./local-script-evidence.ts"
export { enrichGitEvidence } from "./git-evidence.ts"
export { AskDecisionRegistry, DISMISSED_ANSWER } from "./context/ask-decisions.ts"
export type * from "./types.ts"
