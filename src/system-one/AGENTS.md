# Decisions routing contracts

- `decisions-router.ts` selects; `review.ts` and the backend enforce. A parsed
  judgment ends model selection before policy interpretation; difficult or
  contradictory judgments are not transport failures to retry elsewhere.
- Failed-route precedence is structural-seen + invalid-decision `deny`, then
  operational-seen + reviewer-failure `deny`, otherwise the terminal category.
  Classified stops use it too; cancellation/deadline returns explicitly bypass it.
- Model-specific HTTP400 classification needs the complete bounded message;
  drop oversized text rather than classify a truncated prefix. Preserve known
  HTTP status when its error body fails to read; caller cancellation still wins.
- `EnvelopeAttemptRecords` mirrors live `push` synchronously into the envelope;
  other mutations are not its synchronization API. Keep `Symbol.species = Array`
  so derived `slice`/`map` copies never inherit a destination or mirroring `push`.

From the root, run focused `tests/v2-decisions-{router,transport,backend}.test.ts`
suites for these seams; selection tests alone do not establish final disposition.
