# V2 cross-seam safeguards

- Racing credential lookup only cancels the waiter. Pass the attempt signal into
  `backend-factory.ts`'s resolver and check it before `active()`, between
  `active()` and `resolve()`, and after resolution so late stages cannot proceed.
- Core gates and cancellation can replace the entire result. Keep durable model
  provenance on `ReviewEnvelope.decisionTrace`, then sanitize and re-project it in
  `server.ts` after replacements, before publishing UI/audit metadata.

From the root, use `tests/v2-system-one-factory.test.ts` for deferred credential
stages and `tests/v2-server.test.ts` for real gate/provenance compositions. Do not
change protected enforcement gates merely to preserve transport metadata.
