# 10 — APS-044 — Prove evaluator invariants with isolated mutations

**Status:** ready-for-agent
**Milestone:** 8 — Evaluation Completion
**Blocked by:** APS-043 — Trigger threshold gate.
**Dependency rationale:** Milestone 7 qualification precedes Milestone 8 under PRD §41.
**PRD requirements:** [PRD.md](../../../PRD.md) §21.

**What to build:** Every currently implemented evaluator invariant has an executable proof that a known-good artifact passes and one intentional violation fails for the expected reason.

## Scope and implementation boundaries

Extend the existing evaluator and filesystem-backed fixture test builders. Inventory existing invariants and reuse existing negative cases instead of duplicating a parallel test suite. The matrix is test coverage of the current contract, not a new validation engine or a mandate to refactor the evaluator.

PRD.md remains the sole specification; §4–5 and §42 apply. Later tickets introducing invariants must extend this same matrix. A failure caused by invalid test setup does not demonstrate coverage of the intended invariant.

## Acceptance criteria

- [ ] Each current invariant maps to a known-good input, a single intentional mutation, and its expected evaluator failure.
- [ ] Coverage includes approval digest modification, write-before-approval, generated description removal, unsupported verification evidence, final payload mismatch, and duplicated shared rules, alongside the other implemented invariants.
- [ ] Known-good inputs pass before mutation; tests assert the relevant diagnostic or failure identity, not merely a nonzero exit.
- [ ] Physical scope/identity and actual filesystem delta invariants use the existing physical snapshot approach rather than trusting self-reported action logs.
- [ ] Mutations are independent: one case's changes cannot contaminate another case or conceal which invariant failed.
- [ ] The matrix is executable in normal tests; no skipped/TODO or expected-red placeholders count toward completeness.
- [ ] Completion evidence identifies the inventory covered and leaves a clear existing pattern for invariants added by freshness, pruning, and qualification work.

## Verification

Run each known-good/mutation pair, the full project evaluator suite, and `npm test`. Inspect diagnostics for the intended failure and verify there are no mutation cases that pass accidentally. Record any uncovered invariant as unfinished work rather than declaring the matrix complete.
