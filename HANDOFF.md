# Handoff: opencode-permission-reviewer (capyBearista fork), OpenCode 2.2.5 follow-up

Written 2026-11-02. This file is untracked in the fork root. Don't commit it.

<original_task>
The user (Arjun Pramanik, GitHub `capyBearista`) owns a fork `capyBearista/opencode-permission-reviewer` (integration branch `personal/active`, not contributed upstream). It is also checked out at `~/opencode-plugins/external/opencode-permission-reviewer`, which is not tracked by the `opencode-plugins` repo (excluded via `.git/info/exclude`). OpenCode is now v2.2.5, and the user asked for the following, step by step:

1. Fan out Haiku Explore agents to chart what changed in OpenCode from v2.2.0 to v2.2.5, and what open PR #6 (`refactor/v2-only-opencode-2.2`) needed to change as a result.
2. Re-check upstream `warc0s/opencode-permission-reviewer:main` for new changes. Only API calls to the OpenRouter and OpenCode providers are of interest.
3. Independently test whether OpenCode's free `jev-1.13-free` Decisions endpoint is reachable. The user saw issues in `packages/opencode-auto-advisor` (in the `opencode-plugins` repo), which uses `ctx.experimental.generate.decisions`.

The work later expanded, at the user's direction:
- Raise the fork's minimum to OpenCode 2.2.5 and OpenTUI 0.8.
- Fix the CI V1 check.
- File an Issue instead of migrating to `generate.decisions`.
- Investigate and fix the failing coverage gates properly.
- Fix the brake gaps that surfaced.
- Move the remaining workflows to Bun 1.4.4.
- Fix the zod advisory and update dependencies to their latest versions.
- Push, merge PR #6, sync locally, clean up the worktrees, and bump the submodule in the config repo.
</original_task>

<work_completed>
## Research findings
- **OpenCode 2.2.0 → 2.2.5** (diffed by tag in the shallow clone `~/codebases/opencode`; tag v2.2.5 was fetched with `git fetch --depth=1 origin 'refs/tags/v2.2.5:refs/tags/v2.2.5'`):
  - The plugin-facing files are byte-identical: `host.ts`, `permission.ts`, `promise/permission.ts`, `mcp.ts`, `rpc.ts`, `server/src/location.ts`, and `tui/src/plugin/*`.
  - The `generate.decisions` input is unchanged; only its types were renamed, and the old names remain as deprecated aliases.
  - **Breaking change:** `@opencode/plugin` 2.2.3+ peers `@opentui/core|solid >=0.8.0`.
  - Other changes:
    - 2.2.5 routes a tool named `bash` to `shell`;
    - 2.2.3 narrowed `integration.use` in managed policy (new `mcp.use`, `skill.use`, `plugin.use`);
    - 2.2.1 added an `experimental.idle` hook;
    - 2.2.4 added an artifact API.
- **Upstream `warc0s` main:** unchanged since 2.5.0 (2026-10-27). Only dependency bumps on side branches. Nothing to port.
- **Free Jev probe:**
  - Both `POST https://opencode.ai/zen/v1/systemone` (the fork's URL) and `https://opencode.ai/inference/systemone/v1/systemone` (the host's URL, `packages/ai/src/providers/opencode.ts:7`) returned **429 `FreeUsageLimitError`**. Their `Retry-After` values counted down together (~6.2 h), so they share one quota.
  - The host classifies `FreeUsageLimitError` as an exhausted quota and does not retry it.
  - The auto-advisor skips a model for only 60 s (`packages/opencode-auto-advisor/src/fallback.ts`), so it keeps hitting the 429. Its findings doc `docs/auto-advisor/findings.md:99` records the same thing.
  - The fork's router retries the 429 twice (~2 s total), then moves to the next model.
  - No OpenCode docs mention either URL; the URL appears only in source.
- **Decision:** keep the fork's own Decisions transport. Filed **Issue #7** (https://github.com/capyBearista/opencode-permission-reviewer/issues/7) to revisit `generate.decisions`. The blockers:
  - no AbortSignal (`packages/plugin/src/promise/adapter.ts:266-285`);
  - `retryOneShot` retries 3 times and honours `retry-after` up to 15 min;
  - instructions are strings only, and predicate questions take no criteria (`packages/schema/src/generate.ts:113-138`);
  - the API is still experimental.

  The user also said: don't switch to the `inference` URL.

## Commits merged via PR #6
Merged into `personal/active` as merge commit **`412b440`**. The remote branch is kept at `d9168f5`. All commits are SSH-signed. The commits from the earlier session (`9ca041c` … `6c0392b`) are also in this merge. This session's commits:
1. `a353365 fix(compat)`: `tests/compatibility/install-package.ts` now requires `default.setup` and rejects a `server` key. The error message is "must export a V2 setup entry and no V1 server".
2. `2aeea1f build!: require OpenCode 2.2.5 and OpenTUI 0.8`:
   - `SUPPORTED_V2_RANGE`, engines and the peer are now `>=2.2.5 <3`; OpenTUI peers `>=0.8.0`.
   - `host-contracts.json` now pins 2.2.5, with integrity hashes for the cli and the sdk.
   - pytest defaults, the boundary tests (2.2.4 and `2.2.5-beta.1` are rejected) and the docs are updated.
   - The `package-smoke` solid-js check now uses `Bun.semver.satisfies`, because OpenTUI 0.8's peer is `^1.9.12`.
3. `24b28ed fix(brake)`: `1>&/dev/sda` now trips the brake. Bash treats it like `>&`.
4. `7af7f4e test`: `script_analysis` bounds and the `privilegeEscalation` condition.
5. `c684ed3 ci`:
   - Bun 1.4.4 in `ci.yml`; `engines.bun >=1.4.4`;
   - the coverage gate runs as a separate step with `if: !cancelled()`.
6. `028ad65 fix(brake)`:
   - the lexer's `redirectionOperatorAt` requires an operator to start on an unquoted character, and its lookahead stops at a quoted character;
   - only unquoted digits form an IO number;
   - a shared predicate `redirectionWritesBlockDevice` also checks segment-level redirections, covering commandless `{…;} >&`, `(…) 1>&` and `exec >&`;
   - the benchmark pins for `emergency-brake.ts` and `shell-lexer.ts` are updated.
7. `8d65e05 test(coverage)`: `scripts/check-coverage.ts` ignores lcov paths starting with `../` or absolute. New test file: `tests/check-coverage.test.ts`.
8. `6240fec refactor(capability)`: removed the unreachable `extractRedirections` fallback from `src/capability/command-parser.ts`, and updated its pin.
9. `1cf97d3 test`: router and backend failure paths, heredoc delimiter decoding (checked against bash), revalidation deny, git status failure, SSH evidence.
10. `af1c576 ci`: `release.yml` and `host-advisory.yml` move to Bun 1.4.4.
11. `d9168f5 build(deps)`:
    - zod 4.6.5 → 4.6.7 (fixes GHSA-mrhx-c7xc-m3w5);
    - `@typesafe-ai/sdk` moved to devDependencies, still at 0.6.0;
    - semver 7.8.6, OpenTUI 0.8.1, solid-js 1.9.18, and tooling at latest.

## Verification
CI on `d9168f5` was **all green**:
- check: 1142 pass, 0 fail;
- coverage: 90.9%;
- hosts (npm, bun), benchmark and CodeQL: pass.

Locally:
- the real-host suite on OpenCode 2.2.5 passed 28/28 via the npm-packed package, the bun-packed package and source;
- benchmark 79/79, parity check passes;
- a consumer-tree npm audit reports 0 advisories.

Four independent code reviews found no critical or important issues.

## Wrap-up
- The PR #6 body was rewritten via REST. `gh pr edit` fails on a Projects-classic GraphQL error, so use `gh api -X PATCH repos/capyBearista/opencode-permission-reviewer/pulls/6 -F body=@file`.
- Fork checkout `~/opencode-plugins/external/opencode-permission-reviewer` is at `412b440`, clean, with dependencies installed and `dist/` rebuilt.
- The fork worktree under `.claude/worktrees/...` was removed and its branch deleted with `-d`.
- The `opencode-plugins` session worktree `opencode-v2-plugin-compat-56e56a` was removed and its branch deleted with `-d`; it was at `323d572`, the same commit as `origin/main`.
- Config repo `~/.config/opencode`:
  - The submodule `integrations/opencode-permission-reviewer` was fast-forwarded to `412b440`, then `bun install --frozen-lockfile` and `bun run build`. Smoke check: `dist/index.js` exports `{id, setup}` with no `server` key.
  - Committed **`d5db041 build(integrations): bump opencode-permission-reviewer to 412b440`**, containing only the gitlink. Not pushed.
</work_completed>

<work_remaining>
1. **User:** fully restart OpenCode so the bumped reviewer loads. Re-enable the reviewer if it is still disabled; it lives in `opencode.jsonc`, which only the user edits.
2. **Optional:** push the config repo (`~/.config/opencode`, 1 ahead of `origin/main` with `d5db041`), but only if the user asks.
3. **Optional follow-ups**, none requested:
   - Make the router skip a model straight away on a 429 whose `Retry-After` is longer than the review budget. Today the free-tier quota costs about 2 s per review.
   - Let auto-advisor honour `Retry-After` / quota errors instead of its 60 s skip.
   - Issue #7: `generate.decisions`.
   - Bump `@typesafe-ai/sdk` once Bun or the SDK fixes "Body already used".
   - Move to tsup 9 once the build jobs pin Node ≥22.18.
   - Move to TypeScript 7 once `typescript-eslint` supports it.
   - Align `release.yml` Node 20 with CI's 22.
   - Add a comment at `command-parser.ts` noting that each command and its redirections are pushed together.
</work_remaining>

<attempted_approaches>
- **"zod has no fix"** was carried over from the previous handoff and was wrong. The audit flagged zod `<4.6.6`, with a fix in 4.6.6. npm said "no fix" only because the package pinned 4.6.5 exactly.
- **`@typesafe-ai/sdk` 0.7.0 was rejected.** Its `bufferResponse` locks and then releases the original body. Bun 1.4.4 then reports a buffered body as used, so every request fails with "Body already used", even against a real HTTP server. Node is fine.
- **TypeScript 7** is blocked: `typescript-eslint` 8.72.1 peers TypeScript `<6.1.0`.
- **tsup 9** was skipped: it needs Node ≥22.18. The `tsup` bin starts with `#!/usr/bin/env node`, and the check, hosts and release build jobs use the runner's default Node.
- **Coverage, first conclusion wrong.** I first blamed the Bun version. The real cause is a mix:
  - genuinely untested branches, which Bun ≤1.4.3 hid by over-reporting line hits (1.4.3 passes and 1.4.4 fails on identical code; source probes with a positive control proved the lines never ran);
  - 30 generated temp plugins counted in the global total;
  - the gate chained after `bun test` with `&&`, so a failing test skipped it;
  - the session's `BUN_OPTIONS` preload of `~/.claude/no-agent-summary.js` skewed local numbers by about 0.3 points. Run local coverage with `env -u BUN_OPTIONS`.
- **Some tests turned out not to discriminate**, and were fixed:
  - The first lexer rows (`>'&'f`) passed on the old lexer too. Added `echo 'a'>>f`, which fails on the old lexer.
  - A brake allow-test that relied on a dead condition was vacuous.
  - The SSH sensitive-symlink test is caught only when both the realpath check and the descriptor-path check are removed (defence in depth).
- **Unreachable code was left without fake tests:** router deadline expiry while the review is still active (`decisions-router.ts:380-385`), and the backend's outer catch.
- **Init and explain CLI coverage** stays low because their tests use `Bun.spawn`, which coverage can't instrument.
- **An earlier note said the global config loads the fork checkout.** It doesn't: both `opencode.jsonc` and `cli.json` load `./integrations/opencode-permission-reviewer`, the submodule.
</attempted_approaches>

<critical_context>
- **User rules:**
  - investigate the root cause (`systematic-debugging`);
  - verify the real runtime path;
  - halt and confirm after research or planning;
  - make minimal changes, with no backward compatibility;
  - never push while a branch is in an active PR without approval;
  - commit only when asked;
  - lowercase conventional subjects, no AI trailers, signed commits.
- **Merges:** use a merge commit and keep the remote branch.
- **Config repo:** never touch the user's uncommitted changes, never read `~/.config/opencode/.env`, and don't push unless asked.
- **The user has edited `opencode.jsonc` again.** The current status is: `cli.json` staged, `oh-my-opencode-slim/orchestrator_append.md` staged, `opencode.jsonc` partly staged and partly unstaged (`MM`). The user also said their `permission-reviewer.jsonc` changes are intentional and that they handled `cli.json`. Leave all of it alone.
- **The user doesn't care about release versions;** `package.json` stays at 2.4.0.
- **The fork is a standalone Bun package.** Its scripts: `bun run check`, `bun run test:coverage`, `bun scripts/check-coverage.ts`. Benchmark: run `node --test tests/*.test.mjs` and `bun tests/plugin-parity.mjs --repo ../..` from `benchmarks/permission-reviewer`.
- **Real-host suite:**
  - `PACKAGE_MANAGER=<npm|bun> bun tests/compatibility/install-package.ts` prints a `packagePath`.
  - Then run `V2_HOST_VERSION=2.2.5 OPENCODE_V2_2_2_5=$(readlink -f ~/.opencode/bin/opencode) PLUGIN_PACKAGE_PATH=<path> python -m pytest -q tests/compatibility`.
  - The scratchpad venv may be gone; recreate it with `pip install pytest==9.1.1`.
- **Never run `decisions-compat-probe.ts`.** It makes real requests.
- **Benchmark pins:** `benchmarks/permission-reviewer/lib/plugin.mjs` pins the git blobs of reviewed sources. Update only the pins whose source changed, after reviewing the change.
- **GitHub:** `personal/active` has no branch protection or rulesets.
</critical_context>

<current_state>
- **Complete:**
  - the research and the free-endpoint probe;
  - Issue #7;
  - PR #6, merged (`412b440`) with green CI;
  - local sync of the fork checkout;
  - worktree cleanup (both worktrees);
  - the submodule bump, built and committed as `d5db041` (not pushed).
- **Not started (user):** restart OpenCode and re-enable the reviewer.
- **Open:** whether to push the config repo commit `d5db041`. Default: don't.
- **Temporary files:** this `HANDOFF.md` (untracked in the fork root).
</current_state>
