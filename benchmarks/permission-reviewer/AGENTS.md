# Reviewed-source benchmark boundary

- `lib/plugin.mjs` checks `PINNED_BLOBS` before replay: source drift can fail the
  benchmark before any provider call. Update only affected pins after reviewing
  their source changes; do not use `--allow-drift` to claim source-parity validation.
- `openPlugin()` intentionally imports reviewed pure/core layers, not `index.ts`,
  host backends or filesystem/SSH evidence providers. Keep replay isolated from
  real evidence acquisition when adding benchmark cases or adapters.

Run from this directory:

```bash
node cli.mjs validate
node --test tests/*.test.mjs
bun tests/plugin-parity.mjs --repo ../..
```

The parity command belongs to this directory, not the repository-root `tests/`.
