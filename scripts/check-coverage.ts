/**
 * Coverage gate. Parses the lcov.info produced by `bun test --coverage` and
 * enforces two thresholds:
 *
 *  - global line coverage >= MIN_GLOBAL_LINE_PCT
 *  - every safety-critical module at 100% line coverage
 *
 * Bun does not emit branch-coverage data in its lcov output (BRF/BRH are
 * absent), so this gate is line-only. Branch coverage is covered indirectly by
 * the adversarial test suite (characterization, policy-engine, decision,
 * emergency-brake) rather than by a numeric gate.
 *
 * Run via `bun run test:coverage`.
 */
import { readFileSync, existsSync } from "node:fs"

const LCOV_PATH = "coverage/lcov.info"
const MIN_GLOBAL_LINE_PCT = 90

// Modules whose coverage is a safety invariant: a line drop here is a likely
// behavioral regression, not a cosmetic gap.
const CRITICAL_MODULES: ReadonlySet<string> = new Set([
  "src/decision.ts",
  "src/escalation.ts",
  "src/policy.ts",
  "src/policy/policy-engine.ts",
  "src/emergency-brake.ts",
  "src/redact.ts",
])

interface FileCoverage {
  path: string
  linesFound: number
  linesHit: number
}

function parseLcov(path: string): FileCoverage[] {
  if (!existsSync(path)) {
    console.error(`coverage: lcov report not found at ${path}`)
    console.error("run `bun run test:coverage` first.")
    process.exit(1)
  }
  const text = readFileSync(path, "utf8")
  const files: FileCoverage[] = []
  let current: FileCoverage | null = null
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) {
      current = { path: line.slice(3), linesFound: 0, linesHit: 0 }
    } else if (line.startsWith("LF:") && current) {
      const n = Number(line.slice(3))
      // Reject non-integer / negative values so a malformed report cannot
      // produce NaN totals that silently pass the threshold.
      if (!Number.isInteger(n) || n < 0) continue
      current.linesFound += n
    } else if (line.startsWith("LH:") && current) {
      const n = Number(line.slice(3))
      if (!Number.isInteger(n) || n < 0) continue
      current.linesHit += n
    } else if (line === "end_of_record" && current) {
      files.push(current)
      current = null
    }
  }
  return files
}

function pct(hit: number, found: number): number {
  return found > 0 ? (hit / found) * 100 : 100
}

function main(): void {
  const files = parseLcov(LCOV_PATH)
  const failures: string[] = []

  // Global line coverage.
  const totalFound = files.reduce((n, f) => n + f.linesFound, 0)
  const totalHit = files.reduce((n, f) => n + f.linesHit, 0)
  if (totalFound === 0) {
    // An empty or malformed lcov report must not false-pass as 100%.
    failures.push("lcov report contains no line coverage data (LF total is 0)")
  }
  const globalPct = pct(totalHit, totalFound)
  console.log(`coverage: global lines ${totalHit}/${totalFound} (${globalPct.toFixed(1)}%)`)
  if (globalPct < MIN_GLOBAL_LINE_PCT) {
    failures.push(`global line coverage ${globalPct.toFixed(1)}% < ${MIN_GLOBAL_LINE_PCT}%`)
  }

  // Per-file listing, sorted by lowest coverage first (excludes 100%).
  const gaps = files
    .filter((f) => f.linesFound > 0 && pct(f.linesHit, f.linesFound) < 100)
    .sort((a, b) => pct(a.linesHit, a.linesFound) - pct(b.linesHit, b.linesFound))
  if (gaps.length > 0) {
    console.log("\n  files under 100% line coverage:")
    for (const f of gaps) {
      const p = pct(f.linesHit, f.linesFound)
      console.log(`    ${p.toFixed(1).padStart(5)}%  ${f.linesHit}/${f.linesFound}  ${f.path}`)
    }
  }

  // Safety-critical modules must be fully covered.
  console.log("\n  safety-critical modules (require 100%):")
  for (const f of files) {
    if (!CRITICAL_MODULES.has(f.path)) continue
    const p = pct(f.linesHit, f.linesFound)
    const mark = p === 100 ? "ok" : "FAIL"
    console.log(`    [${mark}] ${p.toFixed(1)}%  ${f.path}`)
    if (p < 100) {
      failures.push(`${f.path}: ${p.toFixed(1)}% (requires 100%)`)
    }
  }

  // Report any critical module that produced no coverage record at all
  // (e.g. renamed or not exercised by any test).
  const covered = new Set(files.map((f) => f.path))
  for (const m of CRITICAL_MODULES) {
    if (!covered.has(m)) {
      failures.push(`${m}: no coverage record (not exercised by tests)`)
      console.log(`    [FAIL] missing  ${m}`)
    }
  }

  if (failures.length > 0) {
    console.error(`\ncoverage: ${failures.length} gate failure(s):`)
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log("\ncoverage: all gates passed.")
}

main()
