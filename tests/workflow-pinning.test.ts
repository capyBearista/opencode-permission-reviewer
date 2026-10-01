import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

/** Every workflow must pin its actions to a full 40-hex commit SHA (with the
 *  version kept as a trailing comment so Dependabot can still bump them).
 *  A mutable tag or branch reference lets the tagged commit's author choose
 *  what code runs in CI and release contexts, which defeats the purpose of
 *  the pre-install guards those workflows carry. */
describe("workflow action pinning", () => {
  test("no workflow uses a mutable action reference", () => {
    const workflowsDir = join(import.meta.dir, "..", ".github", "workflows")
    const files = readdirSync(workflowsDir).filter((file) => file.endsWith(".yml"))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const text = readFileSync(join(workflowsDir, file), "utf8")
      for (const match of text.matchAll(/uses:\s*([^\s#]+)/g)) {
        const ref = match[1]!
        // Local composite actions ship with the repository itself.
        if (ref.startsWith("./")) continue
        const at = ref.lastIndexOf("@")
        expect(at, `${file}: ${ref} must be owner/repo@sha`).toBeGreaterThan(0)
        const version = ref.slice(at + 1)
        expect(
          version,
          `${file}: ${ref.slice(0, at)} is pinned to a mutable reference; use the full commit SHA with a version comment`,
        ).toMatch(/^[0-9a-f]{40}$/)
      }
    }
  })
})
