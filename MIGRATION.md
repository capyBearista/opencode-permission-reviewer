# OpenCode V1 and V2 migration

Use one package with separate server adapters. OpenCode V1 calls `server()`;
V2 calls `setup()`. The pinned contracts and package integrities are recorded
in `tests/compatibility/host-contracts.json`.

| Setting                | V1                            | V2                                    |
| ---------------------- | ----------------------------- | ------------------------------------- |
| Host                   | 1.18.29 or newer V1           | >=2.0.3 <3                            |
| Server config key      | `plugin`                      | `plugins`                             |
| Entry with options     | `[package, options]`          | `{package, options}`                  |
| Terminal config        | `tui.json` or `tui.jsonc`     | Global `cli.json`                     |
| Shell permission       | `bash`                        | `shell`                               |
| Delegation permission  | `task`                        | `subagent`                            |
| Permission application | `once`, `reject`, or no reply | `allow`, `deny`, or `ask` evaluation  |
| Interface transport    | Host TUI events               | Authenticated RPC snapshot and events |

## Install and connect

Build the checkout before registering its directory, or install the published
tarball. No installation lifecycle scripts are required to build the package.
The directory entrypoints and npm exports both resolve the generated files.

Run `init --host v1` or `init --host v2`, optionally with `--tui`. `--host auto`
uses the selected `--binary`; absence or contradictory config stops the write.
`--print`, `--dry-run`, and `--json` do not write files. The JSON report separates
`plannedWrites` from `writes`. Existing entries are detected, comments are
preserved, and changed files receive exclusive backups. Other permission rules
are not converted or reordered.

Put shared policy and retention settings in the trusted global
`~/.config/opencode/permission-reviewer.jsonc`. V1 keeps its root-level
`model`, `variant`, and `outputFormat` settings. V2 configures its primary
Decisions routes with `decisionModels` and its isolated reasoning reviewer with
`reasoningModels`; see [V2 ordered Decisions](./README.md#ordered-decisions-routing)
for the settings and routing behavior. Repository config and unknown-origin
inline options cannot redirect V2 routes or change their attempt limits.

V2 calls Decisions models through fixed native endpoints, so those route IDs do
not need to be available in OpenCode's model catalog. A reasoning model must be
configured in OpenCode for the isolated reviewer to use it. V2 ignores the
legacy root-level `model`, `systemOneFallback`, and `escalationReviewer` route
fields; no migration to those fields is required. V1 configuration remains
unchanged.

V2 defaults `decisionModels` to `opencode/jev-1.13-free` and
`reasoningModels` to `openai/gpt-6-luna` with `medium`, `json_schema`, and a
120,000 ms timeout. Each list accepts 1–8 distinct valid entries. Only the first
reasoning entry is used; later entries are validated but are not failover
reviewers. `decisionMaxAttempts` defaults to 2 total attempts per model,
including the initial request, and accepts 1–5. `decisionAttemptTimeoutMs`
defaults to 10,000 ms and accepts 1,000–60,000 ms per attempt.

V2 validates each route list as a whole. Missing arrays use their defaults;
empty or invalid trusted arrays become empty and mark the config degraded rather
than silently falling back to defaults. Invalid trusted attempt controls use
their safe defaults and also mark the config degraded. Automatic approval stays
disabled while the trusted config is degraded.

`decisionModels` are tried in order. The first structurally valid response
ends routing, including a deny, escalation, low-confidence result, or
contradictory result; none causes a search for a more permissive model. Invalid
responses, network failures, timeouts, and HTTP 408/429/5xx retry the current
model before routing advances. Missing credentials, 401/402/403, 404/410, and
an explicit model-not-found 400 move to the next route, including another route
at the same provider. Generic 400, 413, 422, and unexpected failures stop
routing. Cancellation and the existing total review deadline also stop it.
Routing availability failures do not invoke the reasoning reviewer; reasoning
uses only `reasoningModels[0]` when the existing review rules request it.

Zen's free Decisions route is anonymous. An OpenRouter route uses the active
saved OpenRouter API-key connection in V2, resolved only when that route is
needed. OAuth credentials and environment-key fallback are not used, and there
is no configurable endpoint. Each provider that receives review evidence must
be listed in the trusted global route or reasoning configuration.

V2 service discovery reads OpenCode's local authenticated service registration
instead of probing version-specific health endpoints. The registration must
match the running host version, identify a live process, and use a loopback URL;
the reviewer then proves the plugin instance through its own RPC identity. It
never starts a service. An independent server requires these trusted environment
settings:

```bash
export OPENCODE_PERMISSION_REVIEWER_HOST_URL=http://127.0.0.1:4096
# Set OPENCODE_PASSWORD through your existing secure environment mechanism.
opencode serve --hostname 127.0.0.1 --port 4096
```

The password authenticates the OpenCode server, not the model provider. It is
never stored in audit records or exposed through reviewer RPC. A nonce check
must match this plugin instance before the client accesses reviewer sessions.
Remote TUI clients use the connection already supplied by their host.
The reviewer backend runs inside the server and requires its local filesystem
for isolated locations. An explicit endpoint must identify that same server,
not a separate machine. Non-loopback HTTP endpoints are rejected before sending
credentials; use HTTPS for non-loopback connections.

## Review behavior

V2 Decisions results pass through the existing System One parser and policy
gates. If a selected result requests reasoning, V2 uses the first configured
reasoning model in an isolated location. Structured reasoning uses a validated
result tool; text reasoning parses the complete response, rejects ambiguous
JSON, and keeps the existing corrective re-prompt for an invalid response.
Operational and MCP tools remain denied in that session. A missing model or
unsupported variant is a reviewer failure, not a silent model fallback.
Validated low-confidence denials remain denials.

V2 isolates a reasoning reviewer in a temporary location with only its owned hooks.
The total `reviewBudgetMs` includes context and retries; its default is
`2 * timeoutMs + 60000`. Cancellation and unload close the attempt, interrupt
the auxiliary session when one is active, and discard late results. Retention
keeps reasoning sessions for inspection; otherwise the authenticated client
removes them.
The per-model `decisionMaxAttempts` and per-attempt
`decisionAttemptTimeoutMs` settings do not extend this overall deadline, so it
may stop routing before all configured attempts run.
Deletion is verified after bounded retries. If cleanup cannot be confirmed,
the review fails safely and its isolation guards remain active. Further reviews
are refused if unresolved auxiliary sessions exhaust the cleanup capacity.

Review approval is not proof of tool execution. Both adapters write audit schema 3,
an independent `reviewID`, host generation, native action, and application state.
V1 preserves the published permission ID in `hostRequestID` and `requestID`;
`reply-accepted` means its transport acknowledged the reply. In V2 the compatibility
`requestID` is the review identity, not a host permission ID, and
`evaluation-returned` means the hook returned its evaluation.
If a V1 reply cannot be acknowledged, the UI reports an unknown application
instead of claiming that a human permission request is still pending.
Historical audit records remain readable without destructive migration.
V2 audit records can include up to 40 sanitized `decisionAttempts` entries with
model, route index, attempt, request-sent status, outcome, HTTP status, and
duration. `responseModel` is recorded only for a verified Decisions identity;
`reviewerModel` changes to the reasoning model only when it returns a
successful, conclusive decision. Failed or inconclusive reasoning retains the
selected Decisions model.

The TUI subscribes before loading a snapshot, filters by location and generation,
and uses monotonic revisions. A watchdog or disconnection shows unknown status;
it cannot manufacture a pending human decision or approve a permission.

Other installed plugins can change hooks and tool definitions. Later plugins
can override evaluation results; do not treat this reviewer as an irrevocable
security boundary against arbitrary code loaded into the same host.
The adapter rechecks the captured action before returning and denies if it
changed during review. A plugin changing it after this hook returns remains
outside that guarantee. Losing the server event stream cancels active reviews
and prevents new approvals until the plugin is reactivated.

## Diagnostics and rollback

`doctor` reports local configuration explicitly as `local-only`. For V2 live
status, use `doctor --endpoint <server-url>` with server authentication in the
environment. `explain` reads effective reviewer config; `--defaults` requests
the legacy default-only calculation. It accepts V1 requests and V2 action/resource
inputs, with exact execution input where available.

Pass `--generation v2` to `doctor`, `config print-effective`, or `explain` to
inspect V2 routing settings. These CLI commands default to V1 for compatibility.

Keep exact host and plugin versions and the configuration backups. To return
to V1, restore a V1 host and the matching `plugin`/`tui.json` configuration.
Installing an older V1-only plugin into V2 is not a rollback. Preserve audit
history and retained sessions. Release numbers and tags are chosen separately;
legacy maintenance uses the `v1` npm tag and must not replace `latest`.
