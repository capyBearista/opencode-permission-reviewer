import { pathToFileURL } from "node:url"
import { join } from "node:path"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { OpenCode } from "@opencode/client"
import { hostCompatibleFetch } from "../../src/opencode/v2/connection.ts"
import type { OpenCodeClientLike } from "../../src/opencode/types.ts"

const [generation, url, directory, sessionID, command, sourceRoot] = process.argv.slice(2)
if (!generation || !url || !directory || !sessionID || !command)
  throw new Error("Missing evidence fixture settings")
const root = sourceRoot ?? new URL("../..", import.meta.url).pathname
const load = (path: string) => import(pathToFileURL(join(root, "src", path)).href)
const [{ assembleEvidence, defaultEvidenceProviders }, { buildEvidenceResult }, { resolveConfig }] =
  await Promise.all([load("context/evidence-assembler.ts"), load("context.ts"), load("config.ts")])
const controller = new AbortController()
const password = process.env.OPENCODE_PASSWORD
const headers = password
  ? { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }
  : {}
const reader =
  generation === "v1"
    ? (await load("opencode/v1/context-reader.ts")).createV1ContextReader(
        createOpencodeClient({ baseUrl: url, headers }) as unknown as OpenCodeClientLike,
        controller.signal,
      )
    : (await load("opencode/v2/context-reader.ts")).createV2ContextReader(
        OpenCode.make({ baseUrl: url, headers, fetch: hostCompatibleFetch() }),
        controller.signal,
      )
const config = resolveConfig({ model: "fixture/reviewer", timeoutMs: 30000 })
const request = {
  id: "fixture-evidence",
  sessionID,
  permission: "bash",
  patterns: [command],
  metadata: { command },
  always: [],
}
const envelope = await assembleEvidence(request, defaultEvidenceProviders(), {
  client: reader,
  directory,
  worktree: directory,
  config,
})
const result = buildEvidenceResult(envelope, config)
console.log(
  JSON.stringify({
    text: result.text,
    characters: result.text.length,
    actionEvidenceComplete: result.actionEvidenceComplete,
    intent: envelope.intent?.directUserIntent,
    timings: envelope.timings,
    budget:
      config.maxContextChars +
      config.maxPartChars * 2 +
      config.maxEnrichmentChars +
      config.maxIntentChars,
  }),
)
