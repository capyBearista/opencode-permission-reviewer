import { describe, expect, test } from "bun:test"
import {
  analyzeEffectiveCommands,
  commandSegments,
  effectiveCommands,
  lexSegments,
  shellBasename,
} from "../src/shell-lexer.ts"

function values(tokens: { value: string }[]): string[] {
  return tokens.map((t) => t.value)
}

function firstExecutables(command: string): string[][] {
  const result: string[][] = []
  for (const segment of lexSegments(command)) {
    for (const effective of effectiveCommands(segment)) result.push(values(effective))
  }
  return result
}

describe("shell lexer", () => {
  test("records the separator that ended each segment", () => {
    expect(lexSegments("a; b").map((s) => s.endedBy)).toEqual([";", undefined])
    expect(lexSegments("a && b || c").map((s) => s.endedBy)).toEqual(["&&", "||", undefined])
    expect(lexSegments("a | b & c").map((s) => s.endedBy)).toEqual(["|", "&", undefined])
    expect(lexSegments("a\nb").map((s) => s.endedBy)).toEqual([";", undefined])
    // Parens survive as empty marker segments so grouping events are never
    // lost; `a | | b` keeps dropping its empty middle segment.
    expect(lexSegments("( a )").map((s) => s.endedBy)).toEqual(["(", ")"])
    expect(lexSegments("a | | b").map((s) => s.endedBy)).toEqual(["|", undefined])
  })

  test("commandSegments exposes tokens with the surrounding separators", () => {
    expect(commandSegments("cd /x && git status || cd /y")).toEqual([
      { tokens: ["cd", "/x"], endedBy: "&&" },
      { tokens: ["git", "status"], preceding: "&&", endedBy: "||" },
      { tokens: ["cd", "/y"], preceding: "||" },
    ])
    expect(commandSegments("a # trailing comment\nb")).toEqual([
      { tokens: ["a"], endedBy: ";" },
      { tokens: ["b"], preceding: ";" },
    ])
    expect(commandSegments("( cd /x && ls )")).toEqual([
      { tokens: [], endedBy: "(" },
      { tokens: ["cd", "/x"], preceding: "(", endedBy: "&&" },
      { tokens: ["ls"], preceding: "&&", endedBy: ")" },
    ])
  })

  test("preceding survives separators whose empty segment was dropped", () => {
    expect(commandSegments("( cat f ) | ssh host cmd")).toEqual([
      { tokens: [], endedBy: "(" },
      { tokens: ["cat", "f"], preceding: "(", endedBy: ")" },
      { tokens: ["ssh", "host", "cmd"], preceding: "|" },
    ])
    expect(commandSegments("cd /x && ( cd /y ) && git status")).toEqual([
      { tokens: ["cd", "/x"], endedBy: "&&" },
      { tokens: [], preceding: "&&", endedBy: "(" },
      { tokens: ["cd", "/y"], preceding: "(", endedBy: ")" },
      { tokens: ["git", "status"], preceding: "&&" },
    ])
    expect(lexSegments("( a ) | b").map((s) => [s.precededBy, s.endedBy])).toEqual([
      [undefined, "("],
      ["(", ")"],
      ["|", undefined],
    ])
  })

  test("splits on logical separators but not inside quotes", () => {
    expect(firstExecutables("a; b & c | d")).toEqual([["a"], ["b"], ["c"], ["d"]])
    expect(firstExecutables('printf "a; sudo rm -rf /"')).toEqual([["printf", "a; sudo rm -rf /"]])
    expect(firstExecutables('echo "a && b"')).toEqual([["echo", "a && b"]])
  })

  test("strips line comments only when they begin a token", () => {
    expect(firstExecutables("# sudo rm -rf /\nls")).toEqual([["ls"]])
    expect(firstExecutables("echo a#b")).toEqual([["echo", "a#b"]])
  })

  test("peels privilege wrappers and their value-taking options", () => {
    expect(firstExecutables("sudo rm -rf /")).toEqual([["rm", "-rf", "/"]])
    expect(firstExecutables("sudo -u root rm -rf /")).toEqual([["rm", "-rf", "/"]])
    expect(firstExecutables("sudo -uroot rm -rf /")).toEqual([["rm", "-rf", "/"]])
    expect(firstExecutables("env VAR=1 rm -rf /")).toEqual([["rm", "-rf", "/"]])
    expect(firstExecutables("nice -n 5 rm -rf /")).toEqual([["rm", "-rf", "/"]])
    expect(firstExecutables("stdbuf -oL rm -rf /")).toEqual([["rm", "-rf", "/"]])
  })

  test("peels clustered value-taking options without swallowing the command", () => {
    // getopt clusters: the value sits in the rest of the cluster or, when the
    // value-taking letter is last, in the next token.
    expect(firstExecutables("sudo -nu root rm -rf /")).toEqual([["rm", "-rf", "/"]])
    expect(firstExecutables("sudo -Eu root rm -rf /")).toEqual([["rm", "-rf", "/"]])
    // -un: the value is embedded ("n"), so the executable follows directly.
    expect(firstExecutables("sudo -un rm -rf /")).toEqual([["rm", "-rf", "/"]])
    // Pure clusters never consume the next token.
    expect(firstExecutables("sudo -En rm -rf /")).toEqual([["rm", "-rf", "/"]])
  })

  test("peels systemd-run, strace, ltrace and script -c", () => {
    expect(firstExecutables("systemd-run rm -rf /")).toEqual([["rm", "-rf", "/"]])
    expect(firstExecutables("systemd-run --wait --pipe bash -c 'rm -rf /'")).toEqual([
      ["rm", "-rf", "/"],
    ])
    expect(firstExecutables("systemd-run -p CPUQuota=50% rm -rf /")).toEqual([["rm", "-rf", "/"]])
    expect(firstExecutables("systemd-run --unit cleanup.service rm -rf /")).toEqual([
      ["rm", "-rf", "/"],
    ])
    expect(firstExecutables("strace rm -rf /")).toEqual([["rm", "-rf", "/"]])
    expect(firstExecutables("strace -o /tmp/trace.log rm -rf /")).toEqual([["rm", "-rf", "/"]])
    expect(firstExecutables("ltrace -s 128 rm -rf /")).toEqual([["rm", "-rf", "/"]])
    expect(firstExecutables("script -c 'rm -rf /' /dev/null")).toEqual([["rm", "-rf", "/"]])
    // script without -c starts an interactive session: no command to peel.
    expect(firstExecutables("script -q /dev/null typescript.log")).toEqual([
      ["script", "-q", "/dev/null", "typescript.log"],
    ])
  })

  test("peels timeout, watch and xargs wrappers", () => {
    expect(firstExecutables("timeout 5 make")).toEqual([["make"]])
    expect(firstExecutables("timeout --signal=KILL 10s rm -rf /")).toEqual([["rm", "-rf", "/"]])
    expect(firstExecutables("timeout -s KILL 10s rm -rf /")).toEqual([["rm", "-rf", "/"]])
    expect(firstExecutables("timeout -k 5 10s rm -rf /")).toEqual([["rm", "-rf", "/"]])
    expect(firstExecutables("timeout -- 10s rm -rf /")).toEqual([["rm", "-rf", "/"]])
    expect(firstExecutables("sudo timeout 5 rm -rf /")).toEqual([["rm", "-rf", "/"]])
    expect(firstExecutables("watch ls")).toEqual([["ls"]])
    expect(firstExecutables("watch -n 5 curl https://example.invalid")).toEqual([
      ["curl", "https://example.invalid"],
    ])
    expect(firstExecutables("watch --interval=5 ls")).toEqual([["ls"]])
    expect(firstExecutables("echo hi | xargs curl https://example.invalid")).toEqual([
      ["echo", "hi"],
      ["curl", "https://example.invalid"],
    ])
    expect(firstExecutables("xargs -n 1 curl https://example.invalid")).toEqual([
      ["curl", "https://example.invalid"],
    ])
    expect(firstExecutables("xargs -I{} curl https://example.invalid")).toEqual([
      ["curl", "https://example.invalid"],
    ])
  })

  test("wrapper peeling without a command yields no effective command", () => {
    expect(firstExecutables("timeout 5")).toEqual([])
    expect(firstExecutables("timeout")).toEqual([])
    expect(firstExecutables("xargs")).toEqual([])
  })
  test("peels nested wrappers and env-style assignments together", () => {
    expect(firstExecutables("sudo env VAR=1 rm -rf /")).toEqual([["rm", "-rf", "/"]])
  })

  test("resolves absolute binary paths via basename", () => {
    expect(firstExecutables("/bin/rm -rf /")).toEqual([["/bin/rm", "-rf", "/"]])
    expect(firstExecutables("/usr/bin/rm -rf /")).toEqual([["/usr/bin/rm", "-rf", "/"]])
    expect(shellBasename("/usr/bin/env")).toBe("env")
    expect(shellBasename("/bin/rm")).toBe("rm")
  })

  test("destructures command-string forms", () => {
    expect(firstExecutables("sh -c 'rm -rf /'")).toEqual([["rm", "-rf", "/"]])
    expect(firstExecutables("sudo bash -c 'rm -rf /'")).toEqual([["rm", "-rf", "/"]])
    expect(firstExecutables("su -c 'rm -rf /'")).toEqual([["rm", "-rf", "/"]])
    expect(firstExecutables("env -S 'rm -rf /'")).toEqual([["rm", "-rf", "/"]])
    expect(firstExecutables("bash -ic 'rm -rf /'")).toEqual([["rm", "-rf", "/"]])
  })

  test("destructures ssh, busybox and chroot", () => {
    expect(firstExecutables("ssh host rm -rf /")).toEqual([["rm", "-rf", "/"]])
    expect(firstExecutables("ssh -i /key user@host rm -rf /")).toEqual([["rm", "-rf", "/"]])
    expect(firstExecutables("busybox rm -rf /")).toEqual([["rm", "-rf", "/"]])
    expect(firstExecutables("chroot /rootdir rm -rf /")).toEqual([["rm", "-rf", "/"]])
  })

  test("skips shell keywords at position 0", () => {
    expect(firstExecutables("{ rm -rf /; }")).toEqual([["rm", "-rf", "/"]])
    expect(firstExecutables("(rm -rf /)")).toEqual([["rm", "-rf", "/"]])
    expect(firstExecutables("if true; then rm -rf /; fi")).toEqual([
      ["if", "true"],
      ["rm", "-rf", "/"],
      ["fi"],
    ])
  })

  test("leaves plain executables untouched", () => {
    expect(firstExecutables("grep -r foo .")).toEqual([["grep", "-r", "foo", "."]])
    expect(firstExecutables("echo hello")).toEqual([["echo", "hello"]])
  })

  test("resolves command strings nested within the depth budget", () => {
    // 24 levels of `env -S` chaining (each prefix is one re-entry) is far
    // beyond any legitimate review shape and must still reach the payload.
    const nested = `${"env -S ".repeat(24)}rm -rf /`
    expect(firstExecutables(nested)).toEqual([["rm", "-rf", "/"]])
  })

  test("unbounded nesting is cut off instead of exhausting the stack", () => {
    // Before the depth cap this input blew the JS stack inside the emergency
    // brake path; now the descent just stops past the budget.
    const nested = `${"env -S ".repeat(20_000)}rm -rf /`
    const segments = lexSegments(nested)
    expect(segments.length).toBeGreaterThan(0)
    // No throw is the assertion: the result may legitimately be empty because
    // the destructive tail sits beyond the re-entry budget.
    for (const segment of segments) effectiveCommands(segment)
    expect(true).toBe(true)
  }, 30_000)

  test("cut-off nesting is reported as truncated analysis", () => {
    // A destructively-wrapped command just past the budget is invisible to the
    // deterministic brake; the truncation flag is what downstream gates use to
    // refuse auto-approval for it.
    const overBudget = `${"env -S ".repeat(33)}rm -rf /`
    const overSegments = lexSegments(overBudget)
    const over = analyzeEffectiveCommands(overSegments[0]!)
    expect(over.commands).toEqual([])
    expect(over.truncated).toBe(true)

    const withinBudget = `${"env -S ".repeat(32)}rm -rf /`
    const within = analyzeEffectiveCommands(lexSegments(withinBudget)[0]!)
    expect(within.commands).toEqual([
      [
        { raw: "rm", value: "rm" },
        { raw: "-rf", value: "-rf" },
        { raw: "/", value: "/" },
      ],
    ])
    expect(within.truncated).toBe(false)
  })

  test("exponential command expansion is capped", () => {
    // One sh -c body with more sub-commands than the expansion budget: the
    // destructive tail beyond the budget is invisible to the brake, and the
    // analysis is flagged truncated.
    const body = `${"true; ".repeat(4096)}rm -rf /`
    const script = `sh -c '${body}'`
    const analysis = analyzeEffectiveCommands(lexSegments(script)[0]!)
    expect(analysis.commands.length).toBe(4096)
    expect(analysis.truncated).toBe(true)
    expect(analysis.commands[0]!.map((t) => t.value)).toEqual(["true"])
  }, 30_000)
})
