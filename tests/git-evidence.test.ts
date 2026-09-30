import { afterEach, describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { enrichGitEvidence } from "../src/git-evidence.ts"
import { request } from "./helpers.ts"

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []

async function git(directory: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: directory })
}

async function repositoryAt(directory: string): Promise<string> {
  temporaryDirectories.push(directory)
  await mkdir(directory, { recursive: true })
  await git(directory, ["init", "-b", "staging"])
  await git(directory, ["config", "user.email", "reviewer@example.invalid"])
  await git(directory, ["config", "user.name", "Reviewer Test"])
  await writeFile(join(directory, "target.py"), "before = 1\n")
  await writeFile(join(directory, "unrelated.py"), "before = 1\n")
  await git(directory, ["add", "target.py", "unrelated.py"])
  await git(directory, ["commit", "-m", "fixture"])
  return directory
}

async function repository(): Promise<string> {
  return repositoryAt(await mkdtemp(join(tmpdir(), "approval-reviewer-git-")))
}

afterEach(async () => {
  // Sequential and force: nested fixtures push overlapping paths, so parallel
  // removals race and an already-deleted child would fail the suite.
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe("Git state evidence enrichment", () => {
  test("separates preexisting staging from files a compound command plans to add", async () => {
    const directory = await repository()
    await writeFile(join(directory, "unrelated.py"), "before = 2\n")
    await git(directory, ["add", "unrelated.py"])
    await writeFile(join(directory, "target.py"), "before = 3\n")
    const command = 'git add target.py && git commit -m "bounded change"'
    const result = await enrichGitEvidence(
      request({ patterns: [command], metadata: { command } }),
      directory,
      24_000,
    )
    expect(result.text).toContain("GIT_STATE_ANALYSIS")
    expect(result.text).toContain('"branch": "staging"')
    expect(result.text).toContain('"commitRequested": true')
    expect(result.text).toContain('"plannedAdd"')
    expect(result.text).toContain("target.py")
    expect(result.text).toContain('"preexistingStaged"')
    expect(result.text).toContain("unrelated.py")
  })

  test("shows the bounded diff that checkout would discard", async () => {
    const directory = await repository()
    await writeFile(join(directory, "target.py"), "before = 99\n")
    const command = "git checkout HEAD -- target.py"
    const result = await enrichGitEvidence(
      request({ patterns: [command], metadata: { command } }),
      directory,
      24_000,
    )
    expect(result.text).toContain('"discardTargets"')
    expect(result.text).toContain("target.py")
    expect(result.text).toContain('"affectedTargetNumstat": "1\\t1\\ttarget.py')
  })

  test("uses the repository selected by cd or git -C inside the approved roots", async () => {
    const outer = await mkdtemp(join(tmpdir(), "approval-reviewer-git-outer-"))
    temporaryDirectories.push(outer)
    const directory = await repositoryAt(join(outer, "workspace", "repo"))
    await writeFile(join(directory, "target.py"), "selected = true\n")

    for (const command of [
      `cd ${directory} && git checkout HEAD -- target.py`,
      `git -C ${directory} checkout HEAD -- target.py`,
    ]) {
      const result = await enrichGitEvidence(
        request({ patterns: [command], metadata: { command } }),
        outer,
        24_000,
      )
      expect(result.text).toContain(`"repositoryRoot": "${directory}"`)
      expect(result.text).toContain('"branch": "staging"')
      expect(result.text).toContain('"affectedTargetNumstat": "1\\t1\\ttarget.py')
    }
  })

  test("blocks git inspection of a repository outside the approved roots", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "approval-reviewer-git-ws-"))
    temporaryDirectories.push(workspace)
    const elsewhere = await repository()
    await writeFile(join(elsewhere, "target.py"), "escape = true\n")

    for (const command of [
      `cd ${elsewhere} && git checkout HEAD -- target.py`,
      `git -C ${elsewhere} checkout HEAD -- target.py`,
    ]) {
      const result = await enrichGitEvidence(
        request({ patterns: [command], metadata: { command } }),
        workspace,
        8_000,
      )
      expect(result.text).toContain('"status": "unavailable"')
      expect(result.text).toContain("planned Git directory is outside approved enrichment roots")
      expect(result.text).not.toContain(`"repositoryRoot": "${elsewhere}"`)
      expect(result.text).not.toContain('"branch": "staging"')
    }
  })

  test("blocks a symlinked planned Git directory that resolves outside the roots", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "approval-reviewer-git-link-"))
    temporaryDirectories.push(workspace)
    const elsewhere = await repository()
    const link = join(workspace, "linked-repo")
    await symlink(elsewhere, link)

    const command = "git -C linked-repo checkout HEAD -- target.py"
    const result = await enrichGitEvidence(
      request({ patterns: [command], metadata: { command } }),
      workspace,
      8_000,
    )
    expect(result.text).toContain('"status": "unavailable"')
    expect(result.text).toContain("planned Git directory is outside approved enrichment roots")
  })

  test("blocks a session directory inside a repository whose root is outside the roots", async () => {
    const outer = await repositoryAt(await mkdtemp(join(tmpdir(), "approval-reviewer-git-anc-")))
    const sessionDirectory = join(outer, "workspace")
    await mkdir(sessionDirectory)
    await writeFile(join(outer, "target.py"), "ancestor = true\n")

    const command = "git checkout HEAD -- target.py"
    const result = await enrichGitEvidence(
      request({ patterns: [command], metadata: { command } }),
      sessionDirectory,
      8_000,
    )
    expect(result.text).toContain('"status": "unavailable"')
    expect(result.text).toContain("repository root is outside approved enrichment roots")
    expect(result.text).not.toContain('"branch": "staging"')
  })

  test("allows the repository selected through a parent worktree", async () => {
    const outer = await repositoryAt(await mkdtemp(join(tmpdir(), "approval-reviewer-git-parent-")))
    const sessionDirectory = join(outer, "workspace")
    await mkdir(sessionDirectory)
    await writeFile(join(outer, "target.py"), "parent = true\n")

    const command = "git -C .. checkout HEAD -- target.py"
    const result = await enrichGitEvidence(
      request({ patterns: [command], metadata: { command } }),
      sessionDirectory,
      24_000,
      outer,
    )
    expect(result.text).toContain(`"repositoryRoot": "${outer}"`)
    expect(result.text).toContain('"branch": "staging"')
  })

  test("marks shell-expanded planned paths as unresolved", async () => {
    const directory = await repository()
    const command = 'git add "locales/$locale/messages.json" && git commit -m i18n'
    const result = await enrichGitEvidence(
      request({ patterns: [command], metadata: { command } }),
      directory,
      24_000,
    )
    expect(result.text).toContain('"unresolvedPlannedPaths"')
    expect(result.text).toContain("$locale")
  })

  test("fails closed as unavailable outside a repository", async () => {
    const directory = await mkdtemp(join(tmpdir(), "approval-reviewer-no-git-"))
    temporaryDirectories.push(directory)
    const command = "git commit -m test"
    const result = await enrichGitEvidence(
      request({ patterns: [command], metadata: { command } }),
      directory,
      8_000,
    )
    expect(result.text).toContain('"status": "unavailable"')
    expect(result.text).toContain("not a git repository")
  })
})
