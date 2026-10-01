import type { ParsedCommand, Redirection } from "../types.ts"
import {
  analyzeEffectiveCommands,
  lexSegmentsBounded,
  newAnalysisBudget,
  type ShellToken,
} from "../shell-lexer.ts"
import { extractHeredocs } from "./heredoc-extractor.ts"

/*
 * Reusable command parser.
 *
 * Wraps the existing quote-aware lexer and the heredoc pre-extractor into a
 * single `ParsedCommand` structure consumed by the capability analyzer (and
 * available to evidence providers). The emergency brake keeps calling the raw
 * `lexSegments` / `effectiveCommands` functions unchanged — this module never
 * alters the token stream the brake sees.
 *
 * Dynamic constructs (variables, globs, command substitution, dynamic heredoc
 * bodies) are flagged so the analyzer can mark `parserCompleteness` honestly.
 */

/** Redirection operators recognized by the static extractor. */
const REDIRECTION_OPS = new Set([">", ">>", "<", "<<", ">&", "2>", "&>", "1>", "2>>", "&>>"])

/** Parse a raw bash command into the reusable structure. */
export function parseCommand(rawCommand: string): ParsedCommand {
  const { sanitizedCommand, heredocs, hasDynamicConstructs } = extractHeredocs(rawCommand)
  // Bounded from the start: oversized input or token floods stop HERE, and
  // every segment shares one effective-command budget so wide inputs cannot
  // stay under per-segment ceilings while the total grows unbounded.
  const lex = lexSegmentsBounded(sanitizedCommand)
  const segments = lex.segments
  const effective: ShellToken[][] = []
  const redirections: Redirection[][] = []
  let analysisTruncated = lex.truncated
  const budget = newAnalysisBudget()
  for (const segment of segments) {
    const analysis = analyzeEffectiveCommands(segment, budget)
    analysisTruncated = analysisTruncated || analysis.truncated
    for (const cmd of analysis.commands) {
      effective.push(cmd)
      redirections.push(extractRedirections(cmd))
    }
  }
  const dyn = looksDynamic(sanitizedCommand)
  const dynamic =
    hasDynamicConstructs || dyn || segments.some((segment) => segmentHasDynamic(segment.tokens))

  return {
    sanitizedCommand,
    segments,
    effective,
    redirections,
    heredocs,
    hasDynamicConstructs: dynamic,
    analysisTruncated,
  }
}

/** Extract literal redirections from a token list (best-effort, quote-aware). */
function extractRedirections(tokens: ShellToken[]): Redirection[] {
  const out: Redirection[] = []
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!
    const value = tok.value
    // Combined forms like `2>file` or `1>>file`.
    const combined = /^([0-9]?>>?)\s*(.+)$/.exec(value)
    if (combined) {
      out.push({
        operator: combined[1]!,
        target: combined[2]!,
        quoted: isQuoted(combined[2]!, tok.raw),
      })
      continue
    }
    if (REDIRECTION_OPS.has(value) && i + 1 < tokens.length) {
      const next = tokens[i + 1]!
      out.push({ operator: value, target: next.value, quoted: isQuoted(next.value, next.raw) })
      i += 1
      continue
    }
    if (value.startsWith(">") || value.startsWith("<")) {
      // `>file`, `>>file`, `<file` glued to the target.
      const op = value.startsWith(">>") ? ">>" : value[0]!
      out.push({
        operator: op,
        target: value.slice(op === ">>" ? 2 : 1),
        quoted: isQuoted(value, tok.raw),
      })
    }
  }
  return out
}

function isQuoted(value: string, raw: string): boolean {
  if (raw.length < value.length) return true
  const head = raw[0]
  const tail = raw[raw.length - 1]
  return (head === "'" || head === '"') && head === tail
}

/** Whether the raw command contains dynamic constructs the lexer leaves intact.
 *  Command substitution (`$(...)` or bare backticks) makes analysis OPAQUE;
 *  variables and globs make it PARTIAL. Single-quoted regions are literal and
 *  must NOT trip the detector — so we strip them before checking. */
function looksDynamic(command: string): boolean {
  // Remove single-quoted regions (everything between unescaped `'` pairs) so
  // `echo 'literal $VAR'` does not false-positive. Double quotes still allow
  // expansion in bash, so they are left intact.
  const literal = command.replace(/'[^']*'/g, "")
  return /\$\(|`|\$\{|\$[A-Za-z_]|[?*]\s|<\(|>\(|\[\[/.test(literal)
}

/** Whether a token list itself carries dynamic markers. */
function segmentHasDynamic(tokens: ShellToken[]): boolean {
  return tokens.some((tok) => /\$|[*?]/.test(tok.value) && !isAllLiteral(tok.raw))
}

function isAllLiteral(raw: string): boolean {
  // Single-quoted regions are literal; anything else with $ or glob chars is dynamic.
  return /^'[^']*'$/.test(raw)
}
