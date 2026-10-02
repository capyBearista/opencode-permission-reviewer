import { V1ReviewerBackend } from "../../src/opencode/v1/reviewer-backend.ts"
import { ReviewAttempt } from "../../src/core/review-attempt.ts"
import type { RuntimeContext } from "../../src/opencode/types.ts"
import { probeCapabilities } from "../../src/opencode/capability-detection.ts"
import { config, MockClient, request } from "../helpers.ts"

const base = process.argv[2]
if (!base) throw new Error("Missing isolation fixture directory")
for (let index = 0; index < 20; index++) {
  const client = new MockClient()
  const context: RuntimeContext = {
    client,
    capabilities: probeCapabilities(client),
    permissionReply: client.permissionReply,
    directory: "/workspace/project",
    worktree: "/workspace/project",
    reviewerDirectoryBase: base,
  }
  const backend = new V1ReviewerBackend(
    context,
    config({ audit: false }),
    (message, details) => console.error(message, details),
    () => {},
  )
  const attempt = new ReviewAttempt("fixture", 5000)
  try {
    const result = await backend.review(
      {
        request: request(),
        directory: "/workspace/project",
        worktree: "/workspace/project",
        transcript: "Run printf safe",
        intentHistory: "Run printf safe",
        enrichment: "",
        sshAudit: [],
      },
      attempt,
    )
    if (result.kind !== "allow") throw new Error(result.reason)
  } finally {
    attempt.close("cancelled")
    await backend.waitForIdle()
  }
}
