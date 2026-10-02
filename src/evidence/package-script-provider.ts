import { enrichPackageScriptEvidence } from "../package-script-evidence.ts"
import type { EvidenceFragment, EvidenceProvider, EvidenceProviderInput } from "./provider.ts"

export class PackageScriptEvidenceProvider implements EvidenceProvider {
  readonly id = "package_script"
  async collect(input: EvidenceProviderInput): Promise<EvidenceFragment> {
    const result = await enrichPackageScriptEvidence(
      input.request,
      input.directory,
      input.worktree,
      input.maxChars,
    )
    return { kind: "local_script", text: result.text }
  }
}
