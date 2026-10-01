import { afterEach, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { promisify } from "node:util"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { enrichGitEvidence } from "../src/git-evidence.ts"
import { request } from "./helpers.ts"

const exec = promisify(execFile)
const directories: string[] = []
const git = async (directory: string, ...args: string[]) =>
  (await exec("git", args, { cwd: directory })).stdout.trim()
async function repository() {
  const directory = await mkdtemp(join(tmpdir(), "reviewer-git-operation-"))
  directories.push(directory)
  await git(directory, "init", "-b", "dev")
  await git(directory, "config", "user.name", "Fixture")
  await git(directory, "config", "user.email", "fixture@example.invalid")
  await writeFile(join(directory, "target.txt"), "base\n")
  await git(directory, "add", "target.txt")
  await git(directory, "commit", "-m", "fixture")
  return directory
}
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})
async function evidence(directory: string, command: string) {
  const result = await enrichGitEvidence(
    request({ metadata: { command }, patterns: [command] }),
    directory,
    24000,
    directory,
  )
  return JSON.parse(result.text.split("\n").slice(1).join("\n"))
}

test("rebase evidence distinguishes local commits from observed remote history without rewriting", async () => {
  const directory = await repository()
  const base = await git(directory, "rev-parse", "HEAD")
  await git(directory, "update-ref", "refs/remotes/origin/dev", base)
  await git(directory, "commit", "--allow-empty", "-m", "local-one")
  await git(directory, "commit", "--allow-empty", "-m", "local-two")
  const head = await git(directory, "rev-parse", "HEAD")
  const snapshot = await evidence(
    directory,
    `GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash ${base}`,
  )
  expect(snapshot.rewrite).toMatchObject({
    status: "available",
    base,
    head,
    commitsInRange: 2,
    commitsAbsentFromRemoteTrackingRefs: 2,
    commitsPresentInRemoteTrackingRefs: 0,
  })
  expect(snapshot.rewrite.note).toContain("may be stale")
  expect(await git(directory, "rev-parse", "HEAD")).toBe(head)
  await git(directory, "update-ref", "refs/remotes/origin/dev", head)
  expect(
    (await evidence(directory, `git rebase -i ${base}`)).rewrite.commitsPresentInRemoteTrackingRefs,
  ).toBe(2)
}, 30000)

test("unresolved rebase ranges remain unavailable and stash receives a workspace snapshot", async () => {
  const directory = await repository()
  for (const command of [
    "git rebase --abort",
    "git rebase missing-ref",
    "git rebase --root",
    "git rebase --root dev",
    "git rebase HEAD~1 another-branch",
  ])
    expect((await evidence(directory, command)).rewrite.status).toBe("unavailable")
  await writeFile(join(directory, "target.txt"), "dirty\n")
  const snapshot = await evidence(directory, "git stash push -- target.txt")
  expect(snapshot.plannedCommands).toEqual(["stash"])
  expect(snapshot.unstaged.values).toContain("target.txt")
  expect(await git(directory, "status", "--porcelain")).toContain("target.txt")
}, 30000)

test("merge conflict evidence identifies the merge index and separates unresolved paths", async () => {
  const directory = await repository()
  await git(directory, "switch", "-c", "incoming")
  await writeFile(join(directory, "target.txt"), "incoming\n")
  await writeFile(join(directory, "incoming.txt"), "merge-only\n")
  await git(directory, "add", ".")
  await git(directory, "commit", "-m", "incoming")
  await git(directory, "switch", "dev")
  await writeFile(join(directory, "target.txt"), "current\n")
  await git(directory, "commit", "-am", "current")
  await git(directory, "merge", "incoming").catch(() => {})
  const snapshot = await evidence(directory, "git add target.txt")
  expect(snapshot.indexContext).toBe("merge-result-index")
  expect(snapshot.unmerged.values).toEqual(["target.txt"])
  expect(snapshot.preexistingStaged.values).toContain("incoming.txt")
  expect(snapshot.preexistingStaged.values).not.toContain("target.txt")
  expect(snapshot.note).toContain("does not establish ownership")
}, 30000)

test("literal destinations match only the configured repository and transport role", async () => {
  const directory = await repository()
  await git(directory, "remote", "add", "origin", "git@github.com:Example/Fixture.git")
  const snapshot = await evidence(directory, "git push https://github.com/example/fixture.git dev")
  expect(snapshot.remoteTargets[0]).toMatchObject({
    kind: "literal",
    configuredMatches: [{ name: "origin", push: true, fetch: true }],
  })
  expect(snapshot.remoteTargets[0].note).toContain("does not establish authorization")
  await git(
    directory,
    "remote",
    "set-url",
    "--push",
    "origin",
    "https://github.com/example/other.git",
  )
  expect(
    (await evidence(directory, "git push https://github.com/example/fixture.git dev"))
      .remoteTargets[0].configuredMatches,
  ).toEqual([{ name: "origin", push: false, fetch: true }])
  for (const url of [
    "https://github.com/elsewhere/fixture.git",
    "https://github.com/example/other-repo.git",
    "https://github.com:444/example/fixture.git",
    "http://github.com/example/fixture.git",
    "https://github.com/example/fixture.git?redirect=other",
  ])
    expect(
      (await evidence(directory, `git push ${url} dev`)).remoteTargets[0].configuredMatches,
    ).toBeUndefined()
}, 30000)

test("invocation overrides cannot borrow destination identity from the ordinary repository", async () => {
  const directory = await repository()
  await git(directory, "remote", "add", "origin", "https://github.com/example/fixture.git")
  for (const command of [
    "git -c remote.origin.url=https://other.example.invalid/repo.git push origin dev",
    "git -c url.https://other.example.invalid/.insteadOf=https://github.com/ push https://github.com/example/fixture.git dev",
    "git --git-dir=/outside/repository.git push origin dev",
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.url GIT_CONFIG_VALUE_0=https://other.example.invalid/repo.git git push origin dev",
  ]) {
    const snapshot = await evidence(directory, command)
    expect(snapshot.status).toBe("unavailable")
    expect(snapshot.reason).toContain("overrides are unresolved")
    expect(snapshot.remoteTargets).toBeUndefined()
  }
}, 30000)

test("literal remote matches use expanded fetch and push URLs without changing config", async () => {
  const directory = await repository()
  await git(directory, "remote", "add", "origin", "git@github.com:example/fixture.git")
  const command = "git push https://github.com/example/fixture.git dev"
  await git(
    directory,
    "config",
    "url.https://elsewhere.example.invalid/.pushInsteadOf",
    "https://github.com/",
  )
  const config = await git(directory, "config", "--local", "--list")
  let target = (await evidence(directory, command)).remoteTargets[0]
  expect(target.pushUrls).toEqual(["https://elsewhere.example.invalid/example/fixture.git"])
  expect(target.fetchUrl).toBe("https://github.com/example/fixture.git")
  expect(target.configuredMatches).toEqual([{ name: "origin", push: false, fetch: true }])
  expect(await git(directory, "config", "--local", "--list")).toBe(config)
  await git(
    directory,
    "config",
    "url.https://elsewhere.example.invalid/.insteadOf",
    "https://github.com/",
  )
  target = (await evidence(directory, command)).remoteTargets[0]
  expect(target.configuredMatches).toBeUndefined()
  expect(target.fetchUrl).toBe("https://elsewhere.example.invalid/example/fixture.git")
  expect(await git(directory, "remote")).toBe("origin")
  await git(
    directory,
    "config",
    "url.https://specific.example.invalid/.pushInsteadOf",
    "https://github.com/example/",
  )
  target = (await evidence(directory, command)).remoteTargets[0]
  expect(target.pushUrls).toEqual(["https://specific.example.invalid/fixture.git"])
  await git(
    directory,
    "config",
    "url.https://ambiguous.example.invalid/.pushInsteadOf",
    "https://github.com/example/",
  )
  target = (await evidence(directory, command)).remoteTargets[0]
  expect(target.pushUrls).toBeUndefined()
  expect(target.note).toContain("ambiguous")
}, 30000)
