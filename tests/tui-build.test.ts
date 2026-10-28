import { expect, test } from "bun:test"
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { tmpdir } from "node:os"
import { runtimeModuleIdForSpecifier } from "@opentui/core/runtime-plugin"

const root = resolve(import.meta.dir, "..")

function listFiles(directory: string, base = directory): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...listFiles(path, base))
    else files.push(relative(base, path))
  }
  return files
}

test("builds the TUI graph as host-runtime JavaScript in an isolated package copy", () => {
  const fixture = mkdtempSync(join(tmpdir(), "reviewer-tui-build-"))
  try {
    cpSync(join(root, "src"), join(fixture, "src"), { recursive: true })
    cpSync(join(root, "package.json"), join(fixture, "package.json"))
    mkdirSync(join(fixture, "scripts"), { recursive: true })
    cpSync(join(root, "scripts/copy-tui.ts"), join(fixture, "scripts/copy-tui.ts"))
    symlinkSync(join(root, "node_modules"), join(fixture, "node_modules"), "dir")

    const build = Bun.spawnSync({
      cmd: ["bun", "scripts/copy-tui.ts"],
      cwd: fixture,
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(build.exitCode).toBe(0)

    const output = join(fixture, "dist/tui")
    const files = listFiles(output).sort()
    expect(files).toHaveLength(7)
    expect(files.every((file) => /\.(?:ts|tsx)$/.test(file))).toBe(true)
    expect(files).toContain("tui.tsx")

    const js = new Bun.Transpiler({ loader: "js" })
    const allImports: string[] = []

    for (const file of files) {
      const outputPath = join(output, file)
      const outputSource = readFileSync(outputPath, "utf8")
      const outputImports = js.scan(outputSource).imports.map((item) => item.path)
      const sourcePath = join(fixture, "src", file)
      const sourceLoader = file.endsWith(".tsx") ? "tsx" : "ts"
      const sourceImports = new Bun.Transpiler({ loader: sourceLoader })
        .scan(readFileSync(sourcePath, "utf8"))
        .imports.map((item) => item.path)
        .filter((specifier) => specifier.startsWith("."))
      const outputRelativeImports = outputImports.filter((specifier) => specifier.startsWith("."))

      expect(outputRelativeImports).toEqual(sourceImports)
      for (const specifier of outputRelativeImports) {
        expect(existsSync(resolve(dirname(outputPath), specifier))).toBe(true)
      }
      expect(
        outputImports.filter((specifier) => /^(?:solid-js(?:\/|$)|@opentui\/)/.test(specifier)),
      ).toEqual([])
      allImports.push(...outputImports)
    }

    expect(allImports).toContain(runtimeModuleIdForSpecifier("@opentui/solid"))
    expect(allImports).toContain(runtimeModuleIdForSpecifier("solid-js"))

    const packageJson = JSON.parse(readFileSync(join(fixture, "package.json"), "utf8")) as {
      exports: Record<string, unknown>
    }
    expect(readFileSync(join(fixture, "package.json"), "utf8")).toBe(
      readFileSync(join(root, "package.json"), "utf8"),
    )
    expect(packageJson.exports["./tui"]).toBe("./dist/tui/tui.tsx")
    expect(readFileSync(join(fixture, "src/tui.tsx"), "utf8")).toBe(
      readFileSync(join(root, "src/tui.tsx"), "utf8"),
    )
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})
