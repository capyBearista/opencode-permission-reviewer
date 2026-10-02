<!-- Thanks for the PR. Keep the description focused on the technical change. -->
<!-- Contribution PRs target dev. Maintainer promotion PRs target main from dev. -->

## Summary

<!-- What does this PR change and why? One or two paragraphs. -->

## Safety impact

<!-- If this touches decision.ts, policy.ts, emergency-brake.ts, the reply
     transport, or the config trust boundary, explain why the safety invariants
     are preserved (critical risk never approved, project config cannot weaken
     global, reviewer failure → manual, etc.). If it does not touch safety
     paths, say "None". -->

## Checklist

- [ ] Contribution targets `dev` (or this is a maintainer promotion from `dev` to `main`)
- [ ] `bun run check` is green (format + lint + typecheck + tests + build)
- [ ] No personal data, secrets, or absolute personal paths in the diff
- [ ] Safety changes include regression tests that demonstrate the invariant
- [ ] User-facing strings are in English
- [ ] CHANGELOG entry added (under `[Unreleased]`) if user-visible
- [ ] No version numbers or roadmap references added to code comments

## Test evidence

<!-- For runtime/transport/TUI/build changes: attach the live smoke result
     against a fresh `opencode serve` (see CONTRIBUTING.md). For refactor-only
     changes, note that `bun run check` + `bun run test:package` pass. -->
