# Upgrading to the OpenCode V2-only release

This release supports OpenCode V2 `>=2.2.0 <3` only. OpenCode V1 (1.18.x and
1.19.x) is no longer supported. If you need OpenCode V1, stay on the previous
release of this package (2.4.x).

## What was removed

- **V1 host support.** The V1 `server()` entrypoint, `permission.asked` handling,
  the reply transport, the `@opencode-ai/plugin` dependency, and the V1
  `plugin` / `tui.json` registration. The default export is `{ id, setup }`.
- **Root entry shims.** `server.js`, `rpc.js`, and `tui.tsx` are no longer
  shipped. OpenCode 2.2.0 resolves the package through its `exports`:
  `./server`, `./tui`, and `./rpc`. Point filesystem-local config at the package
  directory, not an entry file.
- **CLI flags.** `init` no longer accepts `--host` or `--tui`. `doctor`,
  `config print-effective`, and `explain` no longer accept `--generation`; they
  always report V2 settings.
- **V1 config keys.** `model`, `systemOneFallback`, and `escalationReviewer` are
  ignored wherever they appear. Choose reviewers with `decisionModels` and
  `reasoningModels`; see
  [ordered Decisions routing](./README.md#ordered-decisions-routing). The V1
  Jev routes that read `OPENCODE_API_KEY`, `TYPESAFE_API_KEY`, or `CMD_API_KEY`
  are gone.
- **Library exports.** The package root no longer exports `server`,
  `ApprovalReviewerRuntime`, `extractPermissionRequest`, or the `HostGeneration`
  and `SystemOneFallbackConfig` types. The `./tui` export now provides only the
  default `{ id, setup }` plugin; its named `tui`, `ReviewUiState`,
  `decodeUiStatus`, and `DEFAULT_CONFIG` exports are gone. `doctor --json` no
  longer reports a `generation` field.

## Upgrade steps

1. Upgrade OpenCode to 2.2.0 or newer. OpenTUI 0.7 comes with it.
2. Register the plugin once, in the plural `plugins` array of `opencode.json`:

   ```jsonc
   { "plugins": [{ "package": "opencode-permission-reviewer", "options": {} }] }
   ```

   `init --npm --yes` writes this entry (add `--global` for the global config).
   OpenCode 2.2.0 loads the TUI overlay from the same entry, so a `cli.json`
   entry is no longer needed; remove an existing one.

3. Fully restart OpenCode.

Historical audit records stay readable. `audit report` still counts V1 records
by host generation.

## Independent server

The registered OpenCode service is discovered from OpenCode's local
authenticated registration, which must match the running host version, identify
a live process, and use a loopback URL. The reviewer then proves the plugin
instance through its own RPC identity. It never starts a service. An
independent `serve` needs these trusted environment settings:

```bash
export OPENCODE_PERMISSION_REVIEWER_HOST_URL=http://127.0.0.1:4096
# Set OPENCODE_PASSWORD through your existing secure environment mechanism.
opencode serve --hostname 127.0.0.1 --port 4096
```

The password authenticates the OpenCode server, not the model provider. It is
never stored in audit records or exposed through reviewer RPC. The endpoint must
identify the same server that runs the plugin, not a separate machine.
Non-loopback HTTP endpoints are rejected before credentials are sent; use HTTPS
for non-loopback connections. For live status, run
`doctor --endpoint <server-url>`; without it, `doctor` reports local
configuration as `local-only`.
