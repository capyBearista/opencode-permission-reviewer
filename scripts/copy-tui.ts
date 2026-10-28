/**
 * Precompile the TUI graph's TypeScript/JSX without bundling it.
 *
 * Mapping Solid/OpenTUI imports to the host runtime IDs keeps one renderer
 * when OpenCode loads this package from node_modules. Keep the relative module
 * graph intact; only the TUI graph is copied, not the server engine.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { runtimeModuleIdForSpecifier } from "@opentui/core/runtime-plugin"

// OpenTUI 0.7.0 ships the transform helper but does not export its subpath.
const solidEntry = import.meta.resolve("@opentui/solid")
const { transformSolidSource } = await import(
  new URL("./scripts/solid-transform.js", solidEntry).href
)

const root = join(import.meta.dir, "..")
const out = join(root, "dist", "tui")

const files = [
  ["src/tui.tsx", "tui.tsx"],
  ["src/ui/components.tsx", "ui/components.tsx"],
  ["src/ui/v2.tsx", "ui/v2.tsx"],
  ["src/ui/rpc.ts", "ui/rpc.ts"],
  ["src/ui-protocol.ts", "ui-protocol.ts"],
  ["src/ui-state.ts", "ui-state.ts"],
  ["src/types.ts", "types.ts"],
] as const

rmSync(out, { recursive: true, force: true })

for (const [from, to] of files) {
  const dest = join(out, to)
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(join(root, from), dest)
}

const runtimeSpecifiers = [
  "solid-js",
  "solid-js/store",
  "@opentui/solid",
  "@opentui/solid/components",
  "@opentui/solid/jsx-runtime",
  "@opentui/solid/jsx-dev-runtime",
] as const
const runtimeModuleIds = new Map<string, string>(
  runtimeSpecifiers.map(
    (specifier) => [specifier, runtimeModuleIdForSpecifier(specifier)] as const,
  ),
)
const moduleName = runtimeModuleIdForSpecifier("@opentui/solid")

for (const [, to] of files) {
  const path = join(out, to)
  const source = readFileSync(path, "utf8")
  const compiled = await transformSolidSource(source, {
    filename: path,
    moduleName,
    resolvePath: (specifier) => runtimeModuleIds.get(specifier) ?? null,
  })
  writeFileSync(path, compiled)
}

// Validate the compiled JavaScript graph. Bun's scanner excludes type-only
// imports, which do not need a shipped runtime module.
const js = new Bun.Transpiler({ loader: "js" })
for (const [, to] of files) {
  const source = readFileSync(join(out, to), "utf8")
  const imports = js.scan(source).imports
  for (const imported of imports) {
    if (!imported.path.startsWith(".")) continue
    const dependency = resolve(dirname(join(out, to)), imported.path)
    if (!existsSync(dependency)) {
      throw new Error(`Missing TUI dependency ${imported.path} imported by ${to}`)
    }
  }
}
