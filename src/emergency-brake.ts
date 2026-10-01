import type { PermissionRequest } from "./types.ts"
import {
  analyzeEffectiveCommands,
  lexSegmentsBounded,
  MAX_ANALYSIS_INPUT_CHARS,
  newAnalysisBudget,
  tokenCharIsQuoted,
  type ShellSegment,
  type ShellToken,
  shellBasename,
} from "./shell-lexer.ts"

/** One segment with its resolved effective commands, computed once per
 *  request and shared by every detector. */
interface AnalyzedSegment {
  segment: ShellSegment
  effective: ShellToken[][]
}

/*
 * Deterministic emergency brake.
 *
 * Inspects a pending bash command for *unmistakable* broad destruction or
 * obvious credential export and rejects it before any model call. Everything
 * ambiguous is left to the reviewer.
 *
 * Root destruction is detected with a quote-aware, wrapper-aware shell lexer
 * (see shell-lexer.ts) so that privilege prefixes (`sudo`, `doas`, `env`,
 * `command`, …), absolute binary paths (`/bin/rm`, `/usr/bin/rm`), combined or
 * separated flags (`-rf`, `-r -f`, `--recursive --force`), end-of-options
 * (`--`), and command-string forms (`sh -c '…'`, `su -c …`, `ssh host …`,
 * `busybox rm …`, `chroot root …`) are peeled before judging the executable.
 *
 * It deliberately does NOT expand variables, globs, command substitutions, or
 * heredocs. Those remain the reviewer's job; the brake only catches literal,
 * unambiguous `rm -rf /`-style root destruction (target resolves to `/`).
 *
 * The whole command is lexed and destructured exactly once per request under
 * a shared analysis budget (input size, tokens, depth, re-lexed text, and
 * total effective commands). When any limit is hit, the brake rejects with a
 * resource-limit reason of its own: the command was NOT proven destructive,
 * only unanalyzable within bounds, and downstream gates must not confuse the
 * two.
 */

const ROOT_DESTRUCTION_REGEX = [
  // Fork bomb. (Block-device formatting/overwrite and rm/find destruction are
  // handled by the lexer-based detectors below so that `echo "mkfs …"` and
  // other non-executable mentions do not trip the brake.)
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
]

const SECRET_EXPORT_UTILITIES = new Set(["curl", "wget", "nc", "ncat", "netcat", "socat"])

const SECRET_EXPORT_TARGETS = [
  /(?:\.ssh\/(?:id_|authorized_keys)|\.aws\/credentials|\.config\/gh\/hosts\.yml)/i,
  /(?:api[_-]?key|access[_-]?token|private[_-]?key|session[_-]?cookie)/i,
]

const ROOT_DESTRUCTION_REASON =
  "Emergency brake: command contains unmistakable broad system destruction."
const SECRET_EXPORT_REASON =
  "Emergency brake: command appears to export credential material through a network utility."
const ANALYSIS_LIMIT_REASON =
  "Emergency brake: command exceeded the static analysis budget (input size, token count, or command-string expansion). Split the command into smaller steps and retry. This is a resource limit, not a detected destruction."

/** Short flags that make `rm` recursive / forceful when clustered (e.g. `-rf`). */
function hasRmFlags(tokens: ShellToken[]): { recursive: boolean; force: boolean } {
  let recursive = false
  let force = false
  let endOfFlags = false
  for (let i = 1; i < tokens.length; i += 1) {
    const value = tokens[i]!.value
    if (!endOfFlags && value === "--") {
      endOfFlags = true
      continue
    }
    if (!endOfFlags && value.startsWith("-") && value.length > 1) {
      if (value === "--recursive" || value === "-R") recursive = true
      else if (value === "--force") force = true
      else if (value.startsWith("--")) {
        // Other long flags (--no-preserve-root, --one-file-system, …): no effect on r/f.
        continue
      } else {
        // Clustered short flags; GNU rm allows them interleaved with operands.
        if (value.includes("r") || value.includes("R")) recursive = true
        if (value.includes("f")) force = true
      }
      continue
    }
  }
  return { recursive, force }
}

/**
 * A literal target resolves to the filesystem root `/` after dropping trailing
 * `.`, `..`, and empty components. We do NOT touch variables, globs, command
 * substitutions, or backslash escapes (the lexer already produced the shell
 * value): those stay non-literal and out of the brake's remit, so `rm -rf '\/'`
 * is left untouched (it is a file literally named `\`-slash, not root).
 */
function resolvesToRoot(rawTarget: string): boolean {
  if (!rawTarget.startsWith("/")) return false
  const stack: string[] = []
  for (const part of rawTarget.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      stack.pop()
      continue
    }
    stack.push(part)
  }
  return stack.length === 0
}

/**
 * A live glob that expands to every entry of the filesystem root (`/*`,
 * `//**`): the shell expands it before rm runs, so `rm -rf /*` destroys the
 * system exactly like `rm -rf /`. The star is only an operator while its
 * characters sit in an UNQUOTED span: `"/"*` still globs (only the slash is
 * quoted), while `'/*'` or `/\*` name a literal file and stay with the
 * reviewer. Trailing `*` and `**` both count: without globstar, `**`
 * behaves like `*` at the root level.
 */
function isLiveRootGlob(token: ShellToken): boolean {
  if (!token.value.startsWith("/")) return false
  const components = token.value.split("/")
  const last = components[components.length - 1]!
  if (!/^\*+$/.test(last)) return false
  const starStart = token.value.length - last.length
  if (tokenCharIsQuoted(token, starStart)) return false
  const stack: string[] = []
  for (const part of components.slice(0, -1)) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      stack.pop()
      continue
    }
    stack.push(part)
  }
  return stack.length === 0
}

function isRmRootDestruction(analyzed: AnalyzedSegment[]): boolean {
  for (const { effective } of analyzed) {
    for (const tokens of effective) {
      if (tokens.length === 0) continue
      if (shellBasename(tokens[0]!.value) !== "rm") continue
      const { recursive, force } = hasRmFlags(tokens)
      if (!recursive || !force) continue
      let endOfFlags = false
      for (let i = 1; i < tokens.length; i += 1) {
        const value = tokens[i]!.value
        if (!endOfFlags && value === "--") {
          endOfFlags = true
          continue
        }
        if (!endOfFlags && value.startsWith("-") && value.length > 1) continue
        if (resolvesToRoot(value) || isLiveRootGlob(tokens[i]!)) return true
      }
    }
  }
  return false
}

/**
 * `find / … -delete` and `find / … -exec rm -rf {} …` reach root through the
 * find expression rather than through a literal `rm` operand, so the rm lexer
 * above does not see them. Detect them directly: when the search root resolves
 * to `/` and the expression deletes its results, the destruction is unmistakable.
 */
function isFindRootDestruction(analyzed: AnalyzedSegment[]): boolean {
  for (const { effective } of analyzed) {
    for (const tokens of effective) {
      if (tokens.length === 0) continue
      if (shellBasename(tokens[0]!.value) !== "find") continue
      let root: ShellToken | null = null
      let hasDelete = false
      let hasExecRm = false
      for (let i = 1; i < tokens.length; i += 1) {
        const value = tokens[i]!.value
        // The search root is the first non-flag operand; everything after it
        // belongs to the expression. Flags that take a value (e.g. `-maxdepth`)
        // are not modelled here, so `find -maxdepth 1 / …` is a false negative
        // (rare and safe) — we never falsely trip.
        if (root === null) {
          if (value.startsWith("-") && value.length > 1) continue
          if (value === "--") continue
          root = tokens[i]!
          continue
        }
        if (value === "-delete") hasDelete = true
        if (value === "-exec" || value === "-execdir" || value === "-ok" || value === "-okdir") {
          // First non-placeholder token after -exec is the executable; if it is
          // `rm` with recursive+force flags, find destroys its matches.
          let j = i + 1
          while (j < tokens.length && (tokens[j]!.value === "{" || tokens[j]!.value === "}")) j += 1
          if (j < tokens.length && shellBasename(tokens[j]!.value) === "rm") {
            const { recursive, force } = hasRmFlags(tokens.slice(j))
            if (recursive && force) hasExecRm = true
          }
        }
      }
      if (
        root !== null &&
        (resolvesToRoot(root.value) || isLiveRootGlob(root)) &&
        (hasDelete || hasExecRm)
      )
        return true
    }
  }
  return false
}

/**
 * Block-device destruction that is unmistakable regardless of arguments:
 * formatting (`mkfs*`, `mke2fs`, `mkswap`), signature wipe (`wipefs -a`),
 * raw overwrite (`dd of=/dev/…`, `shred /dev/…`), partition-table destruction
 * (`sgdisk --zap-all`/`-z`/`--delete=N`, `sfdisk --delete`/`--wipe`,
 * `parted mklabel`/`rm`). Detected via the lexer so privilege wrappers and
 * `echo "mkfs …"` (where the destructive tool is an argument, not the
 * executable) are handled correctly.
 */
const MKFS_FAMILY = /^mkfs(?:\.[a-z0-9]+)?$/
/**
 * Whitelist of real block-device path prefixes so that pseudo-devices
 * (`/dev/null`, `/dev/zero`, `/dev/shm/…`, `/dev/fd/…`, etc.) — which sit under
 * `/dev/` but are not disks — do not trip the brake on legitimate patterns
 * like `dd … of=/dev/null` or `shred /dev/shm/scratch`.
 */
const BLOCK_DEVICE_RE =
  /^\/dev\/(?:sd|hd|vd|xvd|nvme|mmcblk|loop|md|dm-|zram|drbd|bcache|mapper\/|disk\/by-)/

function isBlockDeviceTarget(value: string): boolean {
  return BLOCK_DEVICE_RE.test(value)
}

/** Shell redirection onto a real block device: `> /dev/sda` (or `>>`, `>|`,
 *  an fd-prefixed `2>/dev/sda`, a word-glued `x>/dev/sdc`, or the operator
 *  ending its own token as in `echo x> /dev/sda`) overwrites a disk regardless
 *  of which executable produced the bytes. Only the `>` operator itself must
 *  sit in an unquoted span: quoting part of the TARGET changes nothing about
 *  which file it names (`>"/dev/sda"` and `>/dev/"sda"` redirect to the disk),
 *  while a quoted operator (`echo 'x > /dev/sda'`) is data. */
function redirectTargetsBlockDevice(tokens: ShellToken[]): boolean {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!
    for (const operator of unquotedRedirectOperators(token)) {
      const rest = token.value.slice(operator.start + operator.length)
      if (rest.length > 0) {
        if (isBlockDeviceTarget(rest)) return true
        continue
      }
      const target = tokens[i + 1]
      if (target !== undefined && isBlockDeviceTarget(target.value)) return true
    }
  }
  return false
}

/** Positions and lengths of `>` / `>>` redirect operators whose `>` characters
 *  are all unquoted. `>|` is covered by the trailing-`>` shape: the lexer's
 *  separator handling ends the token at `>`. */
function unquotedRedirectOperators(token: ShellToken): Array<{ start: number; length: number }> {
  const out: Array<{ start: number; length: number }> = []
  const value = token.value
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== ">") continue
    if (tokenCharIsQuoted(token, index)) continue
    const doubled = value[index + 1] === ">" && !tokenCharIsQuoted(token, index + 1)
    out.push({ start: index, length: doubled ? 2 : 1 })
    index += doubled ? 1 : 0
  }
  return out
}

/** Whether a short-flag cluster (e.g. `-af`) contains a given flag letter. */
function shortFlagClusterIncludes(value: string, letter: string): boolean {
  return (
    value.startsWith("-") && !value.startsWith("--") && value.length > 1 && value.includes(letter)
  )
}

function isDeviceDestruction(analyzed: AnalyzedSegment[]): boolean {
  for (let s = 0; s < analyzed.length; s += 1) {
    const { segment, effective } = analyzed[s]!
    if (redirectTargetsBlockDevice(segment.tokens)) return true
    // The clobber-override redirect `>|` loses its `|` to the lexer's
    // separator handling: the operator survives as a trailing `>` with the
    // target as the next segment's first token. A bare `>` at segment end is
    // never valid bash otherwise, so the shape is unambiguous.
    const trailing = segment.tokens.at(-1)
    if (
      trailing !== undefined &&
      (trailing.value === ">" || trailing.value === ">>") &&
      !tokenCharIsQuoted(trailing, 0)
    ) {
      const next = analyzed[s + 1]?.segment.tokens[0]
      if (next !== undefined && isBlockDeviceTarget(next.value)) return true
    }
    for (const tokens of effective) {
      if (tokens.length === 0) continue
      // Command-string destructuring (`sh -c '… > /dev/sda'`, `script -c …`,
      // ssh remote commands) only surfaces inside the resolved effective
      // commands, so the redirect scan runs on them too.
      if (redirectTargetsBlockDevice(tokens)) return true
      const base = shellBasename(tokens[0]!.value)
      const args = tokens.slice(1)
      const targetsBlock = args.some((t) => isBlockDeviceTarget(t.value))

      // tee copies its stdin into every file operand: a real block device
      // operand is a raw overwrite, as unmistakable as shred.
      if (base === "tee" && targetsBlock) return true

      // mkfs / mkfs.* / mke2fs / mkswap: any real block target is destruction,
      // unless a dry-run flag is present (`-n` for mke2fs/mkfs.ext4, `-V`/`-t`
      // alone do not write but are rare; `-n` is the canonical dry-run).
      if (MKFS_FAMILY.test(base) || base === "mke2fs" || base === "mkswap") {
        if (!targetsBlock) continue
        const dryRun = args.some((t) => t.value === "-n" || t.value === "--dry-run")
        if (!dryRun) return true
      }
      // shred: any real block target is destruction.
      if (base === "shred" && targetsBlock) return true

      // wipefs: only --all/-a (alone or clustered like `-af`)/-t wipes
      // signatures; bare wipefs just lists signatures.
      if (base === "wipefs" && targetsBlock) {
        const wipes = args.some((t) => {
          const v = t.value
          return (
            v === "--all" ||
            v === "-a" ||
            shortFlagClusterIncludes(v, "a") ||
            v.startsWith("-t") ||
            v === "--types"
          )
        })
        if (wipes) return true
      }

      // dd: detect `of=<real block device>` (the lexer already stripped quotes).
      if (base === "dd") {
        const hitsBlock = args.some((t) => {
          if (!t.value.startsWith("of=")) return false
          return isBlockDeviceTarget(t.value.slice(3))
        })
        if (hitsBlock) return true
      }

      // sgdisk: destructive ops are --zap-all/-Z (wipe everything), -z/--zap
      // (destroy GPT data structures), and --delete[=N]/-d _N (delete a
      // partition). -d requires a following partition-number argument.
      if (base === "sgdisk" && targetsBlock) {
        const destructive = args.some((t) => {
          const v = t.value
          return (
            v === "--zap-all" ||
            v === "-Z" ||
            v === "--zap" ||
            v === "-z" ||
            v.startsWith("--delete")
          )
        })
        const deleteShort = args.some((t) => t.value === "-d" || t.value === "--delete")
        if (destructive || (deleteShort && args.some((t) => /^[0-9]+$/.test(t.value)))) return true
      }

      // sfdisk: --delete (with partition list) and --wipe* destroy data.
      // NOTE: sfdisk's `-d` is `--dump` (read-only backup), NOT delete — do not
      // share the sgdisk short-flag set.
      if (base === "sfdisk" && targetsBlock) {
        const destructive = args.some((t) => {
          const v = t.value
          return v === "--delete" || v.startsWith("--wipe")
        })
        if (destructive) return true
      }

      // parted: `mklabel` rewrites the partition table; `rm N` deletes a
      // partition.
      if (base === "parted" && targetsBlock) {
        const destructive = args.some((t) => t.value === "mklabel" || t.value === "rm")
        if (destructive) return true
      }
    }
  }
  return false
}

/**
 * Obvious credential export through a network utility. Detected structurally —
 * the executable itself must be the network tool — so a quoted mention inside
 * unrelated text (`echo "curl api_key"`, docs, commit messages) does not trip
 * the brake, exactly like the destruction detectors above. Wrapper peeling
 * (`sh -c`, `ssh host …`, `sudo …`) still reaches the real executable.
 */
function isObviousSecretExport(analyzed: AnalyzedSegment[]): boolean {
  for (const { effective } of analyzed) {
    for (const tokens of effective) {
      if (tokens.length === 0) continue
      if (!SECRET_EXPORT_UTILITIES.has(shellBasename(tokens[0]!.value))) continue
      const args = tokens
        .slice(1)
        .map((token) => token.value)
        .join(" ")
      if (SECRET_EXPORT_TARGETS.some((pattern) => pattern.test(args))) return true
    }
  }
  return false
}

export function emergencyBrakeReason(request: PermissionRequest): string | undefined {
  if (request.permission !== "bash") return
  const command =
    typeof request.metadata.command === "string"
      ? request.metadata.command
      : request.patterns.filter((pattern) => typeof pattern === "string").join("\n")

  // Resource limits come first and are their own outcome: an input the static
  // analysis cannot finish is rejected for THAT reason, before any lexing or
  // detector runs, and is never described as detected destruction. The whole
  // command is lexed and resolved exactly once here; detectors share the
  // result instead of re-analyzing the same text once per detector.
  if (command.length > MAX_ANALYSIS_INPUT_CHARS) return ANALYSIS_LIMIT_REASON
  const lex = lexSegmentsBounded(command)
  if (lex.truncated) return ANALYSIS_LIMIT_REASON
  const budget = newAnalysisBudget()
  const analyzed: AnalyzedSegment[] = []
  for (const segment of lex.segments) {
    const analysis = analyzeEffectiveCommands(segment, budget)
    if (analysis.truncated) return ANALYSIS_LIMIT_REASON
    analyzed.push({ segment, effective: analysis.commands })
  }

  if (isRmRootDestruction(analyzed)) return ROOT_DESTRUCTION_REASON
  if (isFindRootDestruction(analyzed)) return ROOT_DESTRUCTION_REASON
  if (isDeviceDestruction(analyzed)) return ROOT_DESTRUCTION_REASON
  if (ROOT_DESTRUCTION_REGEX.some((pattern) => pattern.test(command)))
    return ROOT_DESTRUCTION_REASON
  if (isObviousSecretExport(analyzed)) return SECRET_EXPORT_REASON
}
