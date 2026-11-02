import { mkdtemp, readFile, appendFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import contracts from "./host-contracts.json"

const releases = Object.entries(contracts.v2.integrities).map(([version, integrity]) => ({
  package: contracts.v2.package,
  version,
  integrity,
}))
for (const release of releases) {
  const directory = await mkdtemp(join(tmpdir(), "reviewer-host-"))
  const proc = Bun.spawn(
    [
      "npm",
      "install",
      "--prefix",
      directory,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      `${release.package}@${release.version}`,
    ],
    { stdout: "inherit", stderr: "inherit" },
  )
  if ((await proc.exited) !== 0) throw new Error("Host installation failed")
  const lock = JSON.parse(await readFile(join(directory, "package-lock.json"), "utf8")) as {
    packages: Record<string, { integrity?: string }>
  }
  if (lock.packages[`node_modules/${release.package}`]?.integrity !== release.integrity)
    throw new Error("Pinned host integrity mismatch")
  const binary = join(directory, "node_modules", "@opencode/cli-linux-x64", "bin", "opencode")
  const variable = `OPENCODE_V2_${release.version.replaceAll(".", "_")}`
  if (process.env.GITHUB_ENV) await appendFile(process.env.GITHUB_ENV, `${variable}=${binary}\n`)
  else console.log(`${variable}=${binary}`)
}
