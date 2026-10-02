import { createHash } from "node:crypto"
import type { HeredocRecord } from "../types.ts"

/*
 * Heredoc extraction.
 *
 * Runs BEFORE the shell lexer used by the capability analyzer, so heredoc
 * bodies never become tokens the analyzer walks. The motivating case is:
 *
 *   cat > /tmp/x <<'EOF'
 *   ...arbitrary content...
 *   EOF
 *   bun /tmp/x
 *
 * The extractor returns the command with each heredoc body replaced by a
 * redacted placeholder, plus structured records (delimiter, expansion flag,
 * bounded+redacted body, sha256 of the full body, output target when a `> path`
 * precedes the heredoc, dynamic flag).
 *
 * NOTE: this protects the capability analyzer and evidence providers only.
 * The emergency brake operates on the RAW command independently and does NOT
 * use this extractor — heredoc bodies may still appear as tokens the brake
 * sees. This is a known conservative limitation (the brake may false-positive
 * on destructive text inside a heredoc body, but never false-negative).
 *
 * This is a bounded static parser, not a shell executor: it never expands the
 * body, never runs anything, and marks bodies with unresolvable expansions as
 * dynamic (partial analysis).
 */

/** Maximum body bytes retained (bounded + redacted for prompt/audit safety). */
const MAX_BODY_BYTES = 4096

/** Characters that cannot appear unquoted inside a heredoc delimiter word.
 *  `$` and backticks are NOT stops: the delimiter word undergoes no
 *  expansion, so they are literal terminator characters. */
const BARE_WORD_STOP = new Set([
  " ",
  "\t",
  "\n",
  "\r",
  "|",
  "&",
  ";",
  "<",
  ">",
  "(",
  ")",
  "\\",
  "'",
  '"',
])

interface DelimiterWord {
  /** Index just past the word. */
  wordEnd: number
  /** Quote-removed delimiter: the line that terminates the body. */
  delimiter: string
  /** Whether any part of the word was quoted (disables body expansion). */
  quoted: boolean
  /** False when the word depends on shell expansion, so the terminator line
   *  is statically unknowable. */
  resolved: boolean
}

/** Parse the delimiter word after a `<<` operator. Bash applies ONLY quote
 *  removal to the word: parameter expansion, command substitution, tilde
 *  expansion, and arithmetic never affect the terminator, because the parser
 *  must match the body's end while reading the script (verified against
 *  bash 5.2: `<<$EOF` with EOF set still terminates at the literal `$EOF`
 *  line). Supported word forms:
 *    - bare characters, including `$`, backticks, `~`: literal
 *    - `'...'`: literal, disables body expansion
 *    - `"..."` and `$"..."`: quote removal (`\$ \` \" \\` drop the
 *      backslash), disables body expansion
 *    - `$'...'`: ANSI-C unescaping, disables body expansion
 *    - `\x` outside quotes: literal `x`, disables body expansion
 *  The word is `resolved: false` only when its quoting never terminates or
 *  the word is empty: then no line can be proven to be the terminator. */
function parseDelimiterWord(command: string, start: number): DelimiterWord {
  let index = start
  let delimiter = ""
  let quoted = false
  let resolved = true
  let sawAny = false

  while (index < command.length) {
    const c = command[index]!
    if (c === "'") {
      const end = command.indexOf("'", index + 1)
      if (end === -1) {
        resolved = false
        break
      }
      delimiter += command.slice(index + 1, end)
      quoted = true
      sawAny = true
      index = end + 1
      continue
    }
    // ANSI-C ($'...') and locale ($"...") quoting both start with `$`
    // followed by a quote; the body-expansion flag is set either way.
    if (c === "$" && (command[index + 1] === "'" || command[index + 1] === '"')) {
      quoted = true
      sawAny = true
      if (command[index + 1] === "'") {
        const parsed = unescapeAnsiC(command, index + 2)
        if (!parsed.closed) {
          resolved = false
          break
        }
        delimiter += parsed.text
        index = parsed.end
      } else {
        index += 1
      }
      continue
    }
    if (c === '"') {
      index += 1
      let closed = false
      while (index < command.length) {
        const d = command[index]!
        if (d === '"') {
          closed = true
          index += 1
          break
        }
        if (d === "\\" && index + 1 < command.length) {
          const escaped = command[index + 1]!
          if ('$`"\\'.includes(escaped)) delimiter += escaped
          else delimiter += `\\${escaped}`
          index += 2
          continue
        }
        delimiter += d
        index += 1
      }
      if (!closed) {
        resolved = false
        break
      }
      quoted = true
      sawAny = true
      continue
    }
    if (c === "\\" && index + 1 < command.length) {
      delimiter += command[index + 1]!
      quoted = true
      sawAny = true
      index += 2
      continue
    }
    if (BARE_WORD_STOP.has(c)) break
    delimiter += c
    sawAny = true
    index += 1
  }
  if (!sawAny) return { wordEnd: start, delimiter: "", quoted: false, resolved: false }
  return { wordEnd: index, delimiter, quoted, resolved }
}

/** Unescape an ANSI-C quoted region (`$'...'`), the subset bash defines for
 *  here-document delimiter words: standard escapes, `\xHH` hex, and up to
 *  three octal digits. Unknown escapes drop the backslash, like bash. A
 *  delimiter containing a newline can never match a body line; it stays
 *  resolved and the body scan reports the heredoc as unterminated. */
function unescapeAnsiC(
  command: string,
  start: number,
): { text: string; end: number; closed: boolean } {
  let text = ""
  let index = start
  while (index < command.length) {
    const c = command[index]!
    if (c === "'") return { text, end: index + 1, closed: true }
    if (c !== "\\") {
      text += c
      index += 1
      continue
    }
    const escaped = command[index + 1]
    if (escaped === undefined) break
    if (escaped === "x") {
      const hex = /^[0-9a-fA-F]{1,2}/.exec(command.slice(index + 2))
      if (hex === null) {
        text += "x"
        index += 2
        continue
      }
      text += String.fromCharCode(Number.parseInt(hex[0], 16))
      index += 2 + hex[0].length
      continue
    }
    if (/^[0-7]/.test(escaped)) {
      const octal = /^[0-7]{1,3}/.exec(command.slice(index + 1))!
      text += String.fromCharCode(Number.parseInt(octal[0], 8))
      index += 1 + octal[0].length
      continue
    }
    const simple: Record<string, string> = {
      a: "\x07",
      b: "\b",
      e: "\x1b",
      E: "\x1b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
      "\\": "\\",
      "'": "'",
      '"': '"',
    }
    text += simple[escaped] ?? escaped
    index += 2
  }
  return { text, end: index, closed: false }
}

/** Result of extracting heredocs from a raw command. */
export interface HeredocExtraction {
  /** Command with heredoc bodies replaced by placeholder tokens. */
  sanitizedCommand: string
  /** Structured heredoc records. */
  heredocs: HeredocRecord[]
  /** Whether any dynamic construct was detected inside a body. */
  hasDynamicConstructs: boolean
}

/**
 * Extract every heredoc in `command`, replacing each body with a placeholder
 * `<HEREDOC:sha256:xxxxxxxx>` so the downstream lexer never sees the content.
 *
 * The scan is quote-aware: `<<` inside quoted strings or comments, and the
 * here-string operator `<<<`, are not heredoc starts. Several heredocs may
 * open on one line; their bodies follow in operator order, as in bash.
 */
export function extractHeredocs(command: string): HeredocExtraction {
  const heredocs: HeredocRecord[] = []
  let hasDynamicConstructs = false
  let out = ""
  let cursor = 0
  let i = 0
  let lineStart = 0
  let inSingle = false
  let inDouble = false
  // Depth of open arithmetic context: `$(( ... ))` anywhere, and `(( ... ))`
  // at a command position. While open, `<<` is a shift operator, not a
  // heredoc: treating `1 << 2` as a heredoc would swallow the rest of the
  // command behind an unterminated "delimiter".
  let arithmeticDepth = 0

  interface PendingStart {
    operator: string
    delimiter: string
    rawWord: string
    quoted: boolean
    resolved: boolean
    opStart: number
    wordEnd: number
    lineStart: number
  }
  const pending: PendingStart[] = []
  let pieces: Array<{ text: string } | { pendingIndex: number }> = []

  const appendText = (text: string) => {
    if (text.length === 0) return
    const last = pieces.at(-1)
    if (last !== undefined && "text" in last) last.text += text
    else pieces.push({ text })
  }

  /** Consume the body of every pending heredoc in operator order, emit the
   *  sanitized start line, and return the index the scan continues from.
   *  `lineEnd` is the newline (or end of command) that closed the start
   *  line, so redirections after the operator stay visible. */
  const consumeBodies = (bodyStart: number, lineEnd: number): number => {
    let position = bodyStart
    const records: Array<{
      bounded: string
      sha256: string
      truncated: boolean
      dynamic: boolean
      outputTarget?: string
    }> = []
    for (const start of pending) {
      let body: string
      let truncated: boolean
      if (start.resolved) {
        const collected = collectBody(command, position, start.delimiter, start.operator === "<<-")
        body = collected.body
        truncated = collected.truncated
        position = collected.endIndex + 1
      } else {
        // The terminator line cannot be known statically, so no line of the
        // remainder can be proven to be a command: it all becomes the body
        // instead of leaking into the analyzer as tokens.
        body = command.slice(position)
        truncated = true
        position = command.length
      }
      const sha256hex = createHash("sha256").update(body).digest("hex")
      const dynamic = start.resolved ? containsDynamic(body, start.quoted) : true
      const { bounded, wasTruncated } = boundBody(body, truncated)
      if (dynamic) hasDynamicConstructs = true
      // The output target may sit before the operator (`cat > /tmp/x <<EOF`)
      // or after the delimiter word (`cat <<EOF > /tmp/x`); both positions
      // redirect the same command's output.
      const outputTarget =
        findOutputTarget(command.slice(start.lineStart, start.opStart)) ??
        findOutputTarget(command.slice(start.wordEnd, lineEnd))
      records.push({
        bounded,
        sha256: sha256hex,
        truncated: wasTruncated,
        dynamic,
        ...(outputTarget === undefined ? {} : { outputTarget }),
      })
    }

    let assembled = ""
    for (const piece of pieces) {
      if ("text" in piece) {
        assembled += piece.text
        continue
      }
      const start = pending[piece.pendingIndex]!
      const record = records[piece.pendingIndex]!
      const shown = start.resolved ? start.delimiter : "<unresolved>"
      const safe = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(shown)
        ? shown
        : `'${shown.replace(/'/g, "'\\''")}'`
      assembled += `${start.operator}${safe} <HEREDOC:sha256:${record.sha256.slice(0, 12)}>`
    }
    out += assembled
    for (let index = 0; index < pending.length; index += 1) {
      const start = pending[index]!
      const record = records[index]!
      heredocs.push({
        delimiter: start.resolved ? start.delimiter : start.rawWord,
        operator: start.operator,
        expansionDisabled: start.quoted,
        bodyBounded: record.bounded,
        bodySha256: record.sha256,
        truncated: record.truncated,
        ...(record.outputTarget === undefined ? {} : { outputTarget: record.outputTarget }),
        dynamic: record.dynamic,
      })
    }
    pending.length = 0
    pieces = []
    return position
  }

  while (i < command.length) {
    const c = command[i]!
    if (inSingle) {
      if (c === "'") inSingle = false
      i += 1
      continue
    }
    if (inDouble) {
      if (c === "\\") i += 1
      else if (c === '"') inDouble = false
      i += 1
      continue
    }
    if (c === "'") {
      inSingle = true
      i += 1
      continue
    }
    if (c === '"') {
      inDouble = true
      i += 1
      continue
    }
    if (c === "\\" && i + 1 < command.length) {
      i += 2
      continue
    }
    // A comment hides the rest of its line from the shell, so it can hide no
    // heredoc either.
    if (c === "#" && (i === 0 || /[\s;&|()]/.test(command[i - 1]!))) {
      while (i < command.length && command[i] !== "\n") i += 1
      continue
    }
    if (arithmeticDepth > 0) {
      if (c === "(") arithmeticDepth += 1
      else if (c === ")") arithmeticDepth -= 1
      i += 1
      continue
    }
    if (
      (c === "$" && command[i + 1] === "(" && command[i + 2] === "(") ||
      (c === "(" && command[i + 1] === "(" && (i === 0 || /[\s;&|()]/.test(command[i - 1]!)))
    ) {
      arithmeticDepth = 2
      i += c === "$" ? 3 : 2
      continue
    }
    if (c === "\n") {
      if (pending.length > 0) {
        appendText(command.slice(cursor, i))
        const resume = consumeBodies(i + 1, i)
        out += "\n"
        cursor = i = resume
        lineStart = resume
        continue
      }
      lineStart = i + 1
      i += 1
      continue
    }
    if (c === "<" && command[i + 1] === "<") {
      let j = i + 2
      const operator = command[j] === "-" ? "<<-" : "<<"
      if (operator === "<<-") j += 1
      if (command[j] === "<") {
        // Here-string: the word is an inline argument, not a body.
        i = j + 1
        continue
      }
      while (j < command.length && (command[j] === " " || command[j] === "\t")) j += 1
      const word = parseDelimiterWord(command, j)
      appendText(command.slice(cursor, i))
      pending.push({
        operator,
        delimiter: word.delimiter,
        rawWord: command.slice(j, word.wordEnd),
        quoted: word.quoted,
        resolved: word.resolved,
        opStart: i,
        wordEnd: word.wordEnd,
        lineStart,
      })
      pieces.push({ pendingIndex: pending.length - 1 })
      cursor = i = word.wordEnd
      continue
    }
    i += 1
  }

  if (pending.length > 0) {
    appendText(command.slice(cursor, command.length))
    consumeBodies(command.length, command.length)
    cursor = command.length
  }
  out += command.slice(cursor)
  return { sanitizedCommand: out, heredocs, hasDynamicConstructs }
}

/** Scan the text before a heredoc operator for a trailing `> path` target. */
function findOutputTarget(beforeOperator: string): string | undefined {
  // Match the last `>` / `>>` redirection target on the start line.
  const trimmed = beforeOperator.replace(/\s+$/, "")
  const match = />>?\s*([^\s|;&<>]+)\s*$/.exec(trimmed)
  return match === null ? undefined : stripQuotes(match[1]!)
}

function stripQuotes(token: string): string {
  if (token.length >= 2) {
    const head = token[0]
    const tail = token[token.length - 1]
    if ((head === "'" || head === '"') && head === tail) return token.slice(1, -1)
  }
  return token
}

/** Collect the heredoc body until the delimiter line. Returns the body text and
 *  the index just past the closing delimiter line. */
function collectBody(
  source: string,
  start: number,
  delimiter: string,
  tabStripped: boolean,
): { body: string; endIndex: number; truncated: boolean } {
  let i = start
  let body = ""
  let truncated = false
  while (i < source.length) {
    let lineEnd = source.indexOf("\n", i)
    if (lineEnd === -1) lineEnd = source.length
    const line = source.slice(i, lineEnd)
    const candidate = tabStripped ? line.replace(/^\t+/, "") : line
    if (candidate === delimiter) {
      // Preserve the trailing newline in the stream so the lexer still splits
      // the command that follows the heredoc into its own segment.
      return { body, endIndex: lineEnd, truncated }
    }
    body += line + "\n"
    if (body.length > MAX_BODY_BYTES * 4) truncated = true
    i = lineEnd + 1
  }
  // Unterminated heredoc: treat the remainder as the body (partial).
  truncated = true
  return { body, endIndex: source.length, truncated }
}

function boundBody(
  fullBody: string,
  alreadyTruncated: boolean,
): { bounded: string; wasTruncated: boolean } {
  const bytes = Buffer.byteLength(fullBody, "utf8")
  if (bytes <= MAX_BODY_BYTES) return { bounded: fullBody, wasTruncated: alreadyTruncated }
  // Truncate by character count as a conservative approximation.
  let cut = 0
  let len = 0
  while (cut < fullBody.length && len < MAX_BODY_BYTES) {
    len += Buffer.byteLength(fullBody[cut]!, "utf8")
    cut += 1
  }
  return { bounded: fullBody.slice(0, cut) + "\n…[truncated]", wasTruncated: true }
}

/** Whether the body contains constructs that prevent static analysis. */
function containsDynamic(body: string, expansionDisabled: boolean): boolean {
  if (expansionDisabled) return false
  // With expansion enabled, `$VAR`, `$(...)`, and backticks are unresolvable.
  return /\$\(?|`/.test(body)
}
