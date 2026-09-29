import { basename } from "node:path"
import type { PermissionRequest } from "./types.ts"
import { sourceCommand } from "./evidence/source-command.ts"
import {
  analyzeScriptContent,
  includeEvidenceFile,
  shellCommandSegmentsWithDirectory,
  type FileEvidence,
} from "./ssh-evidence.ts"

export interface LocalScriptEnrichmentResult {
  text: string
}

const INTERPRETERS = new Set([
  "python",
  "python3",
  "node",
  "bun",
  "bash",
  "sh",
  "zsh",
  "ruby",
  "perl",
])

const INLINE_CODE_OPTIONS = new Set(["-c", "-e", "--eval", "-p", "--print", "-s", "--stdin"])
const OPTIONS_WITH_VALUE = new Set([
  "-W",
  "-X",
  "-r",
  "--require",
  "--loader",
  "--import",
  "-I",
  "-M",
  "-m",
])

// Subcommands whose next operand names a package or workspace, never a local
// script file. `run` is absent: it accepts a direct file target and is handled
// by the dedicated run-target logic in scriptPath.
const BUN_SUBCOMMANDS = new Set([
  "add",
  "build",
  "create",
  "install",
  "link",
  "pm",
  "publish",
  "remove",
  "test",
  "unlink",
  "update",
  "x",
])

// Bun flags that consume a value; that value is never the run target.
// `--cwd` and `--config` are absent on purpose: see the conservative bail in
// scriptPath.
const BUN_VALUE_OPTIONS = new Set([
  "-F",
  "--filter",
  "--elide-lines",
  "--shell",
  "--env-file",
  "--preload",
  "--tsconfig-override",
])

// A `bun run` target that names a file. A bare operand may resolve to a
// package.json script (Bun also falls back to module resolution when no
// script matches), so only separator- or extension-bearing operands are
// classified as files; other targets conservatively gather no evidence.
function bunRunFileTarget(token: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) return false
  return token.includes("/") || /\.(?:[mc]?[jt]sx?)$/i.test(token)
}

function scriptPath(
  tokens: string[],
  interpreterIndex: number,
  interpreter: string,
): string | undefined {
  let bunRunTarget = false
  for (let index = interpreterIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (token === "-" || INLINE_CODE_OPTIONS.has(token) || token === "-m") return
    // Bun applies --cwd before resolving the run target, and --config takes an
    // optional value that makes the next token ambiguous. Guessing the
    // resolution could attach evidence to the wrong file, so gather nothing.
    if (
      interpreter === "bun" &&
      (token === "--cwd" ||
        token.startsWith("--cwd=") ||
        token === "--config" ||
        token.startsWith("--config="))
    ) {
      return
    }
    if (OPTIONS_WITH_VALUE.has(token) || (interpreter === "bun" && BUN_VALUE_OPTIONS.has(token))) {
      index += 1
      continue
    }
    if (token.startsWith("-")) continue
    if (interpreter === "bun" && token === "run" && !bunRunTarget) {
      bunRunTarget = true
      continue
    }
    if (/[$`*?{}<>]/.test(token)) return
    // The first non-option operand after `bun run` is decisive: a path-like
    // token is the executed file, anything else is a manifest script name.
    if (bunRunTarget) return bunRunFileTarget(token) ? token : undefined
    if (interpreter === "bun" && BUN_SUBCOMMANDS.has(token)) return
    return token
  }
  return
}

function interpreterIn(tokens: string[]): number {
  return tokens.findIndex((token) => INTERPRETERS.has(basename(token)))
}

function recordFor(interpreter: string, path: string, file: FileEvidence): Record<string, unknown> {
  return {
    kind: "local_script",
    interpreter,
    path,
    status: file.status,
    ...(file.reason === undefined ? {} : { reason: file.reason }),
    ...(file.size === undefined ? {} : { size: file.size }),
    ...(file.includedBytes === undefined ? {} : { includedBytes: file.includedBytes }),
    ...(file.includedSha256 === undefined ? {} : { includedSha256: file.includedSha256 }),
    ...(file.content === undefined
      ? {}
      : {
          signals: analyzeScriptContent(file.content),
          content: file.content,
        }),
  }
}

export async function enrichLocalScriptEvidence(
  request: PermissionRequest,
  directory: string,
  worktree: string,
  maxChars: number,
): Promise<LocalScriptEnrichmentResult> {
  if (request.permission !== "bash") return { text: "" }
  const segments = shellCommandSegmentsWithDirectory(sourceCommand(request), directory)
  const records: Array<Record<string, unknown>> = []
  const seen = new Set<string>()

  for (const segment of segments) {
    const interpreterIndex = interpreterIn(segment.tokens)
    if (interpreterIndex < 0) continue
    const interpreter = basename(segment.tokens[interpreterIndex]!)
    const path = scriptPath(segment.tokens, interpreterIndex, interpreter)
    if (!path) continue
    const key = `${interpreter}\0${path}`
    if (seen.has(key)) continue
    seen.add(key)
    const file =
      segment.directory === undefined && !path.startsWith("/")
        ? {
            source: "file" as const,
            path,
            status: "unavailable" as const,
            reason: segment.directoryReason ?? "working directory is unresolved",
          }
        : await includeEvidenceFile(path, segment.directory ?? directory, worktree, maxChars)
    records.push(recordFor(interpreter, file.path, file))
  }

  if (records.length === 0) return { text: "" }
  const serialized = JSON.stringify(records, null, 2)
  const bounded =
    serialized.length <= maxChars
      ? serialized
      : `${serialized.slice(0, maxChars)}\n<local_script_enrichment_truncated characters="${serialized.length - maxChars}" />`
  return { text: `LOCAL_SCRIPT_ANALYSIS\n${bounded}` }
}
