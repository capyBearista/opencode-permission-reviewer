import { basename } from "node:path"
import { effectiveCommands } from "../shell-lexer.ts"

/** Resolve an executable tail only when its local filesystem scope is preserved. */
export function localExecutableCommand(
  tokens: string[],
): { tokens: string[]; prefix: string[] } | undefined {
  // The shared segment reader already removed real redirections before
  // flattening token values. Remaining operator characters are argument data;
  // reconstructing unquoted tokens would reinterpret them as redirections.
  const normalized = tokens.map((value) => ({
    raw: value,
    value,
    spans: [{ text: value, quoted: true }],
  }))
  const commands = effectiveCommands({ tokens: normalized })
  if (commands.length !== 1) return
  const command = commands[0]!.map((token) => token.value)
  const offset = normalized.length - command.length
  // A command-string expansion does not establish the inner cwd. Requiring
  // the original tail also prevents command arguments from becoming executables.
  if (offset < 0 || command.some((value, index) => normalized[offset + index]?.value !== value))
    return
  const prefix = normalized.slice(0, offset).map((token) => token.value)
  if (prefix.some((token) => ["--help", "--version"].includes(token))) return
  if (
    prefix.some((token) => basename(token) === "command") &&
    prefix.some((token) => /^-[vV]+$/.test(token))
  )
    return
  if (
    prefix.some((token) =>
      [
        "ssh",
        "chroot",
        "docker",
        "podman",
        "kubectl",
        "nsenter",
        "systemd-run",
        "su",
        "runuser",
        "script",
        "bash",
        "sh",
        "zsh",
        "dash",
        "ksh",
        "ash",
        "mksh",
        "fish",
      ].includes(basename(token)),
    )
  )
    return
  if (
    prefix.some(
      (token) =>
        /^-(?!-)[^-]*[CDR]/.test(token) ||
        /^--(?:chdir|chroot|working-directory)(?:=|$)/.test(token),
    )
  )
    return
  return { tokens: command, prefix }
}
