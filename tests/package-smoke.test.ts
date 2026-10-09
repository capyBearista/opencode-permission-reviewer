import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"

const CWD = import.meta.dir + "/.."

// Build a real tarball once and inspect it with tar. The build is explicit:
// installs run no lifecycle scripts (no `prepare`), so `npm pack` would pack a
// stale or missing dist otherwise. This avoids depending on npm's stdout
// formatting (which emits non-JSON banners/notices in some environments) and
// validates what would actually be published. Nothing is uploaded.
//
// Pack lazily inside the tests rather than in beforeAll: build + npm pack can
// exceed the default hook timeout on slow runners, and not every supported Bun
// release accepts a timeout option on beforeAll. Per-test timeouts (third arg)
// are the portable path.
let tmpDir: string | undefined
let tgzPath: string | undefined
let installDir: string | undefined

function packOnce(): string {
  if (tgzPath !== undefined) return tgzPath
  if (process.env.REVIEWER_TEST_TARBALL) {
    tgzPath = resolve(process.env.REVIEWER_TEST_TARBALL)
    expect(existsSync(tgzPath)).toBe(true)
    return tgzPath
  }
  const build = Bun.spawnSync({
    cmd: ["bun", "run", "build"],
    cwd: CWD,
    stdout: "ignore",
    stderr: "pipe",
  })
  expect(build.exitCode).toBe(0)
  tmpDir = mkdtempSync(join(tmpdir(), "reviewer-pkg-"))
  const pack = Bun.spawnSync({
    cmd: ["npm", "pack", "--ignore-scripts", "--pack-destination", tmpDir],
    cwd: CWD,
    stdout: "ignore",
    stderr: "pipe",
  })
  expect(pack.exitCode).toBe(0)
  const name = readdirSync(tmpDir).find((f) => f.endsWith(".tgz"))
  expect(name).toBeTruthy()
  tgzPath = join(tmpDir, name!)
  return tgzPath
}

afterAll(() => {
  if (tmpDir !== undefined) rmSync(tmpDir, { recursive: true, force: true })
  if (installDir !== undefined) rmSync(installDir, { recursive: true, force: true })
})

async function listTarball(path: string): Promise<string[]> {
  const proc = Bun.spawn({ cmd: ["tar", "-tzf", path], stdout: "pipe", stderr: "pipe" })
  const [exitCode, text] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
  if (exitCode !== 0) throw new Error("tar list failed")
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((entry) => entry.replace(/^package\//, ""))
    .sort()
}

async function readFromTarball(path: string, member: string): Promise<string> {
  const proc = Bun.spawn({
    cmd: ["tar", "-xOzf", path, `package/${member}`],
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, text] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
  if (exitCode !== 0) throw new Error(`tar extract ${member} failed`)
  return text
}

describe("npm pack ship set", () => {
  test("the tarball contains the dist bundle and metadata, nothing else", async () => {
    const files = await listTarball(packOnce())

    for (const required of [
      "package.json",
      "README.md",
      "CHANGELOG.md",
      "LICENSE",
      "NOTICE",
      "SECURITY.md",
      "dist/index.js",
      "dist/index.d.ts",
      "server.js",
      "tui.tsx",
      "rpc.js",
      "dist/rpc.js",
      "MIGRATION.md",
      "dist/explain.js",
      // TUI ships as raw TSX so the host compiles it with its Solid pipeline.
      "dist/tui/tui.tsx",
      "dist/tui/config.ts",
      "dist/tui/config/loader.ts",
      "dist/tui/config/jsonc.ts",
      "dist/tui/ui-protocol.ts",
      "dist/tui/ui-state.ts",
      "dist/tui/types.ts",
      "dist/tui/opencode/event-normalizer.ts",
    ]) {
      expect(files).toContain(required)
    }

    // No prebundled TUI entry — that shape fails to render on the host.
    // Guard the whole dist/tui/ tree: only raw .ts/.tsx sources may ship there.
    const tuiFiles = files.filter((f) => f === "dist/tui" || f.startsWith("dist/tui/"))
    expect(tuiFiles.length).toBeGreaterThan(0)
    expect(tuiFiles.every((f) => f === "dist/tui" || /\.(ts|tsx)$/.test(f))).toBe(true)
    expect(files.some((f) => f === "dist/tui.js" || /^dist\/tui\.js(\.|$)/.test(f))).toBe(false)

    // Nothing from src/, tests/, config, or gitignored/personal files may ship.
    const forbidden = files.filter(
      (f) =>
        f.startsWith("src/") ||
        f.startsWith("tests/") ||
        f.startsWith("scripts/") ||
        f.startsWith(".github/") ||
        f.startsWith("node_modules/") ||
        f === "AGENTS.md" ||
        f === "CONTRIBUTING.md" ||
        f === "CODE_OF_CONDUCT.md" ||
        f === "tsup.config.ts" ||
        f === "tsconfig.json" ||
        f === "eslint.config.ts" ||
        f === ".gitignore" ||
        f === ".prettierrc.json" ||
        f === ".prettierignore" ||
        f === "bun.lock" ||
        f.endsWith("-plan.md"),
    )
    expect(forbidden).toEqual([])
  }, 120_000)

  test("the packaged package.json is public and points at dist", async () => {
    const pkg = JSON.parse(await readFromTarball(packOnce(), "package.json")) as Record<
      string,
      unknown
    >
    expect(pkg.private).toBeUndefined()
    expect(pkg.main).toBe("./dist/index.js")
    expect(pkg.types).toBe("./dist/index.d.ts")
    const exports = pkg.exports as Record<string, unknown>
    expect((exports?.["."] as Record<string, string> | undefined)?.import).toBe("./dist/index.js")
    expect(exports?.["./tui"]).toBe("./dist/tui/tui.tsx")
  }, 120_000)
})

// Supply-chain surface. `@opentui/core` pulls optional platform-specific
// native packages into the INSTALL tree (that is the host TUI pipeline's
// runtime, documented in the README), but none of it may ship inside the
// tarball, no new direct runtime dependency may appear unnoticed, and the
// reviewer SDK's effect runtime must stay external to our bundles.
describe("supply-chain surface", () => {
  test("the tarball ships no native binaries or platform packages", async () => {
    const files = await listTarball(packOnce())
    // Native addons and prebuilt shared libraries, loose or in prebuilds/
    // directories. OpenTUI's native payload is a .so/.dylib, not a .node
    // addon, so those extensions are checked too.
    expect(files.filter((f) => /\.(node|so|dylib|dll)$/.test(f))).toEqual([])
    expect(files.filter((f) => f.split("/").includes("prebuilds"))).toEqual([])
    // npm platform-package layout anywhere in the path: <name>-<os>-<cpu>
    // [-musl] (e.g. `@opentui/core-linux-x64`), whether hoisted at the top,
    // under node_modules/, or inside a bundled-dependency payload.
    const platformPackage =
      /(?:^|\/)(@[^/]+\/)?[^@/][^/]*-(linux|darwin|win32|android|freebsd|aix|sunos)-(x64|arm64|armv7l|ppc64|s390x|riscv64)(-musl)?(\/|$)/
    expect(files.filter((f) => platformPackage.test(f))).toEqual([])
  }, 120_000)

  test("the packaged package.json installs without executing anything", async () => {
    const pkg = JSON.parse(await readFromTarball(packOnce(), "package.json")) as Record<
      string,
      unknown
    >
    // No lifecycle script may (re)appear: installs from the registry, a Git
    // URL, or a local path must execute nothing from this repository.
    for (const script of [
      "prepare",
      "preinstall",
      "install",
      "postinstall",
      "prepack",
      "postpack",
      "prepublishOnly",
      "prepublish",
      "postpublish",
    ]) {
      expect((pkg.scripts as Record<string, string> | undefined)?.[script]).toBeUndefined()
    }
    // A bundled-dependency payload would smuggle files past the ship-set
    // checks (npm packs them under node_modules/).
    expect(pkg.bundleDependencies).toBeUndefined()
    expect(pkg.bundledDependencies).toBeUndefined()
  }, 120_000)

  test("the runtime dependency set is exactly the reviewed allowlist", async () => {
    const pkg = JSON.parse(await readFromTarball(packOnce(), "package.json")) as {
      dependencies: Record<string, string>
      peerDependencies: Record<string, string>
    }
    // A new direct dependency (native or not) must be a deliberate, reviewed
    // change: update this frozen list in the same commit that adds it.
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      "@opencode/client",
      "@typesafe-ai/sdk",
      "jsonc-parser",
      "semver",
      "zod",
    ])
    expect(Object.keys(pkg.peerDependencies).sort()).toEqual([
      "@opencode-ai/plugin",
      "@opencode/plugin",
      "@opentui/core",
      "@opentui/solid",
      "solid-js",
    ])
    // The effect runtime reaches users through the host's plugin SDK, never
    // through a direct dependency of ours.
    expect(
      [...Object.keys(pkg.dependencies), ...Object.keys(pkg.peerDependencies)].some((n) =>
        n.includes("effect"),
      ),
    ).toBe(false)
  }, 120_000)

  test("the effect runtime stays external to every shipped bundle", async () => {
    const files = await listTarball(packOnce())
    const bundles = files.filter((f) => /^dist\/[^/]+\.js$/.test(f))
    expect(bundles.length).toBeGreaterThan(0)
    for (const member of bundles) {
      const bundle = await readFromTarball(packOnce(), member)
      // `effect` may appear as a literal (e.g. permission `"effect": "ask"`),
      // but never as a module specifier: tsup externalizes it, so an
      // accidental import stays visible here instead of being silently
      // inlined. The runtime is resolved by the host from @opencode-ai/plugin's
      // own dependency chain, never vendored by us.
      expect(bundle).not.toMatch(/(?:from|import|require)\s*\(?\s*["']effect(?:\/|["'])/)
    }
  }, 120_000)
})

// The TUI is compiled from raw TSX against the host-owned Solid/OpenTUI
// runtime. The published plugin must not install a second renderer or the
// Seroval/Babel tree through optional rendering peer dependencies.
describe("npm install host-owned TUI runtime", () => {
  test("optional peers match development renderer requirements", async () => {
    const pkg = JSON.parse(await readFromTarball(packOnce(), "package.json")) as {
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
      peerDependencies: Record<string, string>
      peerDependenciesMeta: Record<string, { optional: boolean }>
    }
    const opentui = JSON.parse(
      await Bun.file(join(CWD, "node_modules/@opentui/solid/package.json")).text(),
    ) as {
      version: string
      peerDependencies: Record<string, string>
    }
    for (const name of ["@opentui/core", "@opentui/solid", "solid-js"]) {
      expect(pkg.dependencies[name]).toBeUndefined()
      expect(pkg.peerDependenciesMeta[name]).toEqual({ optional: true })
      expect(pkg.devDependencies[name]).toBeDefined()
    }
    expect(pkg.devDependencies["solid-js"]).toBe(opentui.peerDependencies["solid-js"])
    expect(pkg.devDependencies["@opentui/solid"]).toBe(opentui.version)
    expect(pkg.devDependencies["@opentui/core"]).toBe(opentui.version)
  }, 120_000)

  test("a standalone npm consumer imports the server without installing TUI libraries", async () => {
    installDir = mkdtempSync(join(tmpdir(), "reviewer-install-"))
    const install = Bun.spawnSync({
      cmd: [
        "npm",
        "install",
        "--prefix",
        installDir,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        packOnce(),
      ],
      cwd: installDir,
      stdout: "ignore",
      stderr: "pipe",
    })
    expect(install.exitCode).toBe(0)
    const pluginDir = join(installDir, "node_modules", "opencode-permission-reviewer")
    expect(existsSync(pluginDir)).toBe(true)

    const imported = Bun.spawnSync({
      cmd: [
        "bun",
        "-e",
        'const plugin = (await import("opencode-permission-reviewer")).default; if (typeof plugin.server !== "function" || typeof plugin.setup !== "function") process.exit(1)',
      ],
      cwd: installDir,
      stdout: "ignore",
      stderr: "pipe",
    })
    expect(imported.exitCode).toBe(0)

    const installed = new Set<string>()
    const visit = (dir: string, scope?: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === ".bin" || entry.name === ".package-lock.json")
          continue
        const child = join(dir, entry.name)
        if (dir.endsWith("node_modules") && entry.name.startsWith("@")) {
          visit(child, entry.name)
          continue
        }
        if (scope !== undefined || dir.endsWith("node_modules")) {
          installed.add(scope ? `${scope}/${entry.name}` : entry.name)
        }
        visit(child)
      }
    }
    visit(join(installDir, "node_modules"))
    for (const name of [
      "@opentui/core",
      "@opentui/solid",
      "solid-js",
      "seroval",
      "seroval-plugins",
      "@babel/core",
    ]) {
      expect(installed.has(name)).toBe(false)
    }
    expect(existsSync(join(pluginDir, "dist", "tui", "tui.tsx"))).toBe(true)
  }, 240_000)

  test("consumer tree dependency and native surveillance", async () => {
    // Surveillance of what a CONSUMER actually installs from the tarball:
    // the documented advisory exposure, the absence of build-tree-only
    // tools, and the reachable native/platform set. Overrides in this
    // repository's package.json do not follow the tarball, so only what is
    // asserted here (or in npm audit) guards the consumer tree.
    installDir ??= mkdtempSync(join(tmpdir(), "reviewer-install-"))
    if (!existsSync(join(installDir, "node_modules", "opencode-permission-reviewer"))) {
      const install = Bun.spawnSync({
        cmd: [
          "npm",
          "install",
          "--prefix",
          installDir,
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          packOnce(),
        ],
        cwd: installDir,
        stdout: "ignore",
        stderr: "pipe",
      })
      expect(install.exitCode).toBe(0)
    }

    // The build toolchain must not follow the tarball: esbuild (and the
    // advisory it carries) is dev-only by design.
    expect(existsSync(join(installDir, "node_modules", "esbuild"))).toBe(false)
    for (const entry of readdirSync(join(installDir, "node_modules"), { withFileTypes: true })) {
      if (entry.name.startsWith("@esbuild")) {
        throw new Error(`@esbuild scope leaked into the consumer tree: ${entry.name}`)
      }
    }

    // Native/platform surveillance: every platform-specific package name in
    // the consumer tree. The set is frozen; adding one is a supply-chain
    // review, not an accident.
    const platformPattern =
      /(?:-|--)(?:linux|darwin|win32|android|freebsd|netbsd|openbsd|sunos|aix|arm|arm64|x64|x86|ia32|ppc64|riscv64|s390x|musl|glibc|android-arm(?:64)?|fuchsia)(?:$|[/-])/
    const natives: string[] = []
    const walkNatives = (dir: string, scope?: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === ".bin" || entry.name === ".package-lock.json")
          continue
        const full = join(dir, entry.name)
        if (dir.endsWith("node_modules") && entry.name.startsWith("@")) {
          walkNatives(full, entry.name)
          continue
        }
        const packageName = scope === undefined ? entry.name : `${scope}/${entry.name}`
        if (
          (scope !== undefined || dir.endsWith("node_modules")) &&
          platformPattern.test(packageName)
        ) {
          natives.push(packageName)
          continue
        }
        walkNatives(full)
      }
    }
    walkNatives(join(installDir, "node_modules"))
    // The host owns OpenTUI; only client-side optional msgpackr accelerators
    // may appear in the plugin-only consumer installation.
    const msgpackrPlatforms = new Set([
      "@msgpackr-extract/msgpackr-extract-darwin-arm64",
      "@msgpackr-extract/msgpackr-extract-darwin-x64",
      "@msgpackr-extract/msgpackr-extract-linux-arm",
      "@msgpackr-extract/msgpackr-extract-linux-arm64",
      "@msgpackr-extract/msgpackr-extract-linux-x64",
      "@msgpackr-extract/msgpackr-extract-win32-x64",
    ])
    const unexpected = natives.filter((name) => !msgpackrPlatforms.has(name))
    if (unexpected.length > 0) console.log("consumer native set:", natives)
    expect(unexpected).toEqual([])

    // npm audit over the CONSUMER tree (registry reachability required; the
    // repository's own overrides never apply here). No high or critical
    // advisories may be introduced by this plugin.
    const audit = Bun.spawnSync({
      cmd: ["npm", "audit", "--prefix", installDir, "--audit-level=high", "--json"],
      cwd: installDir,
      stdout: "pipe",
      stderr: "pipe",
    })
    const auditText = audit.stdout.toString()
    let vulnerabilities: Record<string, number> | undefined
    try {
      const parsed = JSON.parse(auditText) as {
        metadata?: { vulnerabilities?: Record<string, number> }
      }
      vulnerabilities = parsed.metadata?.vulnerabilities
    } catch {
      // Registry unreachable: surveillance degrades to the structural
      // checks above rather than failing the suite offline.
    }
    if (vulnerabilities !== undefined) {
      expect(vulnerabilities.high ?? 0).toBe(0)
      expect(vulnerabilities.critical ?? 0).toBe(0)
    }
  }, 240_000)
})
