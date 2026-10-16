# Shared source boundaries

## Audit attribution

- `audit.ts` must match the V2 factory's execution eligibility: only
  `reasoningModels[0]` can receive reasoning attribution. A model also listed in
  `decisionModels` still qualifies through its verified primary-attempt evidence.

Validate changes with `bun test tests/v2-decisions-audit.test.ts` from the root;
the inactive-reasoning, empty-reasoning and overlapping-model cases are distinct.
