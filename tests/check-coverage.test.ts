import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const SCRIPT = join(import.meta.dir, "..", "scripts", "check-coverage.ts")
const CRITICAL = [
  "src/decision.ts",
  "src/escalation.ts",
  "src/policy.ts",
  "src/policy/policy-engine.ts",
  "src/emergency-brake.ts",
  "src/redact.ts",
]

let dir: string | undefined
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function record(path: string, found: number, hit: number): string {
  return `SF:${path}\nLF:${found}\nLH:${hit}\nend_of_record`
}

function gate(records: string[]): { code: number; output: string } {
  dir = mkdtempSync(join(tmpdir(), "check-coverage-"))
  mkdirSync(join(dir, "coverage"))
  writeFileSync(join(dir, "coverage", "lcov.info"), `${records.join("\n")}\n`)
  const run = Bun.spawnSync({ cmd: [process.execPath, SCRIPT], cwd: dir })
  return { code: run.exitCode, output: `${run.stdout}${run.stderr}` }
}

const critical = CRITICAL.map((path) => record(path, 10, 10))

test("passes when repository lines meet the global threshold", () => {
  expect(gate([...critical, record("src/other.ts", 100, 90)]).code).toBe(0)
})

test("files outside the repository cannot lift global coverage", () => {
  const result = gate([
    ...critical,
    record("src/other.ts", 100, 80),
    record("../../tmp/generated/index.js", 1000, 1000),
    record("/home/user/.preload.js", 1000, 1000),
  ])
  expect(result.code).toBe(1)
  expect(result.output).toContain("global line coverage")
})
