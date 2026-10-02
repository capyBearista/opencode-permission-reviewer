import { enrichGitEvidence } from "../git-evidence.ts"
import type { EvidenceFragment, EvidenceProvider, EvidenceProviderInput } from "./provider.ts"

/**
 * Wraps {@link enrichGitEvidence} behind the {@link EvidenceProvider} surface.
 * Git evidence resolves the repository from the planned command's directory,
 * but that directory is only a resolution base: inspection is contained to the
 * session directory plus `worktree` (and /tmp/opencode), so a `cd` or
 * `git -C` pointing elsewhere yields an unavailable snapshot instead of
 * inspecting an unrelated repository.
 */
export class GitEvidenceProvider implements EvidenceProvider {
  readonly id = "git"
  async collect(input: EvidenceProviderInput): Promise<EvidenceFragment> {
    const result = await enrichGitEvidence(
      input.request,
      input.directory,
      input.maxChars,
      input.worktree,
    )
    return { kind: "git", text: result.text }
  }
}
