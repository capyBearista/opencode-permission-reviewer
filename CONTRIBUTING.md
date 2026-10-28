# Contributing

Thanks for considering a contribution. This plugin makes automated safety
decisions, so changes need to be deliberate and well-tested.

## Setup

```bash
git clone https://github.com/Warc0s/opencode-permission-reviewer.git
cd opencode-permission-reviewer
git switch dev
bun install
bun run check   # typecheck + tests — must pass before any push
```

## Before you open a PR

Create your branch from `dev` and open your contribution PR against `dev`.
GitHub defaults to `main`, so select `dev` as the base branch explicitly.
Maintainers promote validated changes from `dev` to `main` through a separate
PR; releases are cut from `main`.

1. **`bun run check` is green** (typecheck + full test suite, including the
   stress suite). Do not disable tests to make this pass.
2. **No personal data or secrets in code or tests.** Use clearly-synthetic
   fixtures (e.g. `sk-syntheticcredential...`, documentation IP ranges
   `192.0.2.x` / `203.0.113.x` / `198.51.100.x`, `*.invalid` hostnames). Never
   commit real tokens, keys, personal filesystem paths, or internal codenames.
3. **Safety changes need tests.** Any change to `decision.ts`, `policy.ts`,
   `emergency-brake.ts`, or the runtime enforcement path must include tests
   that demonstrate the invariant (e.g. critical risk can never be approved).
4. **Keep behavior changes backward-compatible** unless you're intentionally
   bumping a version pin or an enforcement invariant, and say so in the PR.
5. **Keep user-facing strings in English.** The policy and reviewer prompts are
   English; runtime/UI messages should be too so the plugin is usable globally.

## Areas that need care

- `src/decision.ts` / `src/policy.ts` / `src/emergency-brake.ts` — these encode
  safety invariants. Document the reasoning for any change.
- The reviewer has no operational tools. V2 exposes only its schema-validated
  result tool in its isolated location; never add operational or MCP access.
- Maintain the real-host pytest harness under `tests/compatibility`. Its
  profiles and synthetic model providers must not inherit user configuration
  or credentials. Pin host versions and integrity, and verify server and TUI
  loading after a fresh build.
- The TUI entry must stay **raw TSX** (see [Build output](#build-output-dist)
  below). Do not reintroduce a prebundled `dist/tui.js`.

## Build output (`dist/`)

- `bun run build` runs tsup to bundle the server and CLI into `dist/index.js`
  and `dist/explain.js`, then runs `bun scripts/copy-tui.ts` to copy the slim
  TUI source graph into `dist/tui/` as **raw TSX**.
- The TUI must stay unbundled: OpenCode's host compiles plugin `.tsx` with its
  own Solid/OpenTUI pipeline, and a prebundled TUI does not render. When you
  touch the TUI, keep the file list in `scripts/copy-tui.ts` in sync with the
  imports of `src/tui.tsx` and its copied modules (no server engine, no
  `node:` builtins).
- `dist/` is gitignored and rebuilt explicitly with `bun run build`: installs
  run no lifecycle scripts (the package declares none), so never rely on
  `bun install` producing `dist/`; never commit build output.
  `tests/package-smoke.test.ts` builds, packs, and verifies the tarball ships
  exactly the expected set (including the raw TUI files and the absence of a
  prebundled TUI).

## Live (end-to-end) testing

`tests/live-v2-smoke.ts` runs against a real OpenCode V2 server and model and
is **not** part of `bun test`. Its fixture, `tests/live-v2-fixture`, has a
placeholder plugin path that must point at your checkout before you start the
host. Install a pinned host with `bun tests/compatibility/install-hosts.ts`,
which prints the executable path. Set `REVIEWER_LIVE_DIRECTORY` to run against a
separate synthetic fixture directory, `REVIEWER_LIVE_PASSWORD` for a registered
service, and `REVIEWER_LIVE_AUDIT_PATH` when trusted global config overrides the
default audit path. The smoke requires a real allow with tool execution, an LLM
denial, and a deterministic emergency-brake denial, each with a matching audit
record; provider failures cannot count as successful denials.

The real-host matrix is in `tests/compatibility`. After `bun run build`, run
`V2_HOST_VERSION=2.2.0 OPENCODE_V2_2_2_0=/path/to/opencode python -m pytest tests/compatibility -q`
(see its [README](./tests/compatibility/README.md) for setup). Each host uses an
isolated home, configuration, provider and audit file; no personal OpenCode
installation is changed.

Pass the matrix a direct OpenCode executable, not a profile launcher or wrapper
that exports its own `HOME`, `XDG_*`, or `OPENCODE_CONFIG*` values. Such a
launcher can intentionally replace the disposable environment created by the
harness, making an otherwise correct runtime appear incompatible. If
`opencode` on `PATH` is a wrapper, use its underlying runtime executable or the
path printed by `tests/compatibility/install-hosts.ts`. This requirement is
specific to isolated testing: normal installations invoke the runtime
directly, while custom profile launchers remain valid deployment setups and
should receive a separate smoke test with their intended configuration.

To exercise the distributed artifact, build first and run
`PACKAGE_MANAGER=npm bun tests/compatibility/install-package.ts` (or `bun` as
the manager). Set `PLUGIN_PACKAGE_PATH` to the returned `packagePath` before
running pytest. Both installation modes disable lifecycle scripts. CI runs
both managers against every pinned host, including real PTY rendering.
The separate weekly host advisory only reports registry drift and does not
change the supported-version contract.
