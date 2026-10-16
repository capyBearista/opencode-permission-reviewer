# Build and packaging constraints

- `copy-tui.ts` emits JavaScript at preserved `.ts`/`.tsx` paths, not raw TSX.
  Clean-installed raw TSX under `node_modules` misses the host transform; preserve
  the unbundled relative graph and host runtime IDs rather than bundling a renderer.
- Adding a TUI runtime import may require extending `copy-tui.ts`'s curated file
  list, even when TypeScript passes. Keep the graph closed; erased type-only
  imports do not require shipped modules, and server-engine dependencies stay out.
- The Solid transform is a shipped but unexported helper resolved beside the
  exactly pinned OpenTUI package entry. Upgrades must verify that helper's layout
  and installed-host loading; optional peer installation must not mask the problem.

From the root: `bun test tests/tui-build.test.ts`, `bun run build`, and
`bun run test:package`. The isolated build test protects graph shape; it does not
replace installed-package host rendering checks.
