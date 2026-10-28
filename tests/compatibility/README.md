# Real-host compatibility matrix

Build with `bun run build`, install pytest (`python -m pip install pytest==9.1.1`)
in a disposable Python environment, and set these executable paths:

```bash
export OPENCODE_V2_2_2_0=/absolute/path/to/opencode-2.2.0
python -m pytest tests/compatibility -q
```

`bun tests/compatibility/install-hosts.ts` installs the pinned Linux binary in a
new temporary directory and prints the required variable. They never replace an existing installation or
edit shell aliases. CI receives these paths through `GITHUB_ENV`.

The V2 server and TUI compile against the minimum supported plugin SDK while
the real-host matrix exercises the minimum and reference host binary (both
2.2.0).

To verify every pinned V2 release locally, run the sequential window harness.
It installs one host at a time, verifies its integrity, runs the real-host
tests, and removes the disposable installation before continuing:

```bash
PYTHON=/path/to/python-with-pytest \
  bun tests/compatibility/verify-v2-window.ts
```

`tests/live-v2-smoke.ts` is the paid-provider smoke for a fresh V2 host. Its
fixture uses a placeholder plugin path that must point at the checkout before
starting the host. Set `REVIEWER_LIVE_DIRECTORY` when running against a
disposable fixture copy, `REVIEWER_LIVE_PASSWORD` for a registered service,
and `REVIEWER_LIVE_AUDIT_PATH` when trusted global config overrides the
default audit path. The smoke proves a real allow and execution, an LLM denial,
and a deterministic emergency-brake denial.

The variables must point to the actual host executable. Do not point them at a
profile launcher that overwrites `HOME`, `XDG_*`, or `OPENCODE_CONFIG*`: that
would bypass the disposable profile created by `conftest.py` and can produce
misleading activation or authentication failures. Use the launcher's
underlying runtime binary or the pinned installer above. End users normally
run a direct OpenCode installation and do not need this distinction. Custom
launchers are also supported when they select a supported runtime and a
coherent configuration, but their profile behavior should be smoke-tested
separately from this isolated matrix.

The pytest modules launch fresh hosts and share only the synthetic HTTP model
provider and filesystem isolation. The MCP regressions count real process
starts across concurrent and sequential reviews, verify that reviewer locations
exclude MCP, and keep operational MCP servers connected.
The TUI module opens real PTYs and verifies visible reviewing and terminal
states. No provider account, key, or paid inference is required.

Set `V2_HOST_VERSION` to select one host release for the functional reviewer
tests, alongside its matching executable variable. For example,
`V2_HOST_VERSION=2.2.1` uses `OPENCODE_V2_2_2_1` without changing the pinned
CI matrix.

Without `PLUGIN_PACKAGE_PATH`, the functional tests load this checkout's built
package. To validate installation, run `PACKAGE_MANAGER=npm bun
tests/compatibility/install-package.ts` or use `PACKAGE_MANAGER=bun`, then set
`PLUGIN_PACKAGE_PATH` to its returned `packagePath`. Packing and installation
disable lifecycle scripts. CI exercises both installed graphs.

Temporary host logs, audit records, and terminal captures remain under pytest's
temporary directory for diagnosis. These artifacts must not be committed.
Only Linux is currently verified by this matrix; other operating systems need
equivalent live validation before being advertised as supported.

`fixtures/v2-native.json` preserves a sanitized projection captured from the
reference host. The tests compare live context, tool correlation, fork
provenance and form events against this contract. `capture-contracts.ts`
also exercises the native form events through the production normalizer.
