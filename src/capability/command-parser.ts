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
 * available to evidence providers). The emergency brake uses the same bounded
 * lexer and heredoc sanitization directly, so both paths share command and
 * redirection semantics.
 *
 * Dynamic constructs (variables, globs, command substitution, dynamic heredoc
 * bodies) are flagged so the analyzer can mark `parserCompleteness` honestly.
 */

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
    for (let index = 0; index < analysis.commands.length; index += 1) {
      const cmd = analysis.commands[index]!
      effective.push(cmd)
      redirections.push(analysis.redirections[index]!)
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
