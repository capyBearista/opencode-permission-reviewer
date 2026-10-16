# Native compatibility evidence

- `v2_decisions_fixture.py` loads built server code and intercepts only the fixed
  Zen/OpenRouter Decisions URLs. Preserve fail-closed local relay behavior and
  restore global fetch on disposal; do not add a production endpoint override.
- The fixture TUI's `file://` re-export bypasses the installed `./tui` export
  chain. For packaging changes, separately point the isolated V2 CLI plugin at
  `PLUGIN_PACKAGE_PATH`, leaving the server fixture wrapper in place.
- A quiet per-run `server.log` does not establish that the TUI loaded. Inspect
  the isolated profile's CLI logs/terminal error output separately; successful
  server permission handling and successful overlay rendering are different checks.

Use the existing `install-hosts.ts`, `install-package.ts` and `conftest.py`
plumbing documented in this directory's `README.md`. `HOST_GENERATION=v2` selects
the V2 matrix; `PACKAGE_MANAGER` selects the installer, and its exported
`PLUGIN_PACKAGE_PATH` must identify that installed artifact rather than the checkout.
