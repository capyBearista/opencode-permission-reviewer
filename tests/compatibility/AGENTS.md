# Native compatibility evidence

- `v2_decisions_fixture.py` loads built server code and intercepts only the fixed
  Zen/OpenRouter Decisions URLs. Preserve fail-closed local relay behavior and
  restore global fetch on disposal; do not add a production endpoint override.
- The fixture TUI's `file://` re-export bypasses the installed `./tui` export
  chain. For packaging changes, separately register `PLUGIN_PACKAGE_PATH` as the
  isolated host's `opencode.json` plugin (OpenCode 2.2.0 loads the TUI half from
  that entry) and check the overlay renders.
- A quiet per-run `server.log` does not establish that the TUI loaded. Inspect
  the isolated profile's CLI logs/terminal error output separately; successful
  server permission handling and successful overlay rendering are different checks.

Use the existing `install-hosts.ts`, `install-package.ts` and `conftest.py`
plumbing documented in this directory's `README.md`. `PACKAGE_MANAGER` selects the
installer, and its exported
`PLUGIN_PACKAGE_PATH` must identify that installed artifact rather than the checkout.
