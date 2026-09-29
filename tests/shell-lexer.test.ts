import { describe, expect, test } from "bun:test"
import {
  analyzeEffectiveCommands,
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
