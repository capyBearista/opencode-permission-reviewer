# opencode-permission-reviewer

Standalone TypeScript/Bun package, not a workspace of the enclosing
`opencode-plugins` monorepo. Use this repository's ESLint, Prettier and tsup scripts,
not the parent's Turbo, Biome or Changesets commands. Bun requires 1.4.2 or newer.
Instruction files are versioned project context; package ship-set rules exclude
them from published artifacts. The default integration branch is `personal/active`.

<!-- bootstrap:managed:start core-commands -->

## Validation

Run from this repository root:

- `bun run typecheck` — TypeScript validation.
- `bun test tests/<name>.test.ts` — focused behavioral tests.
- `bun run check` — formatting, lint, build, typecheck, then full tests.
- `bun run test:coverage` — line coverage gates defined in `scripts/check-coverage.ts`.
- `bun run test:package` — tarball and standalone-consumer smoke tests.
- `bun test tests/tui-build.test.ts` — isolated TUI build-graph regression.

`bun run build` runs both tsup and `scripts/copy-tui.ts`; tsup alone does not
produce the complete package. Coverage requires 90% overall lines and 100% in the
six explicitly listed safety-critical modules.
<!-- bootstrap:managed:end core-commands -->

## Non-obvious guardrails

- GitButler workspace `HEAD` can be synthetic: resolve the intended target and PR
  base explicitly. PR creation can publish ancestor branches; direct landing is
  not a substitute for a PR when the remote source branch must be retained.
- `decisions-compat-probe.ts` makes real external requests when run, even though
  its evidence is synthetic. Its returned-model normalization checks shape only;
  never copy that bypass into production identity validation or run it as CI.

<!-- bootstrap:managed:start subdirectory-index -->

## Scoped instructions

- `src/AGENTS.md` — audit attribution boundaries.
- `src/system-one/AGENTS.md` — Decisions selection, failure classification and traces.
- `src/opencode/v2/AGENTS.md` — credential stages and terminal provenance projection.
- `scripts/AGENTS.md` — TUI compilation and renderer ownership.
- `tests/compatibility/AGENTS.md` — native fixtures and installed-entrypoint coverage.
- `benchmarks/permission-reviewer/AGENTS.md` — reviewed-source parity guard.

<!-- bootstrap:managed:end subdirectory-index -->
