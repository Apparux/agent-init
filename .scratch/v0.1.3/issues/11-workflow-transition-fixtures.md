# 11 — APS-045 — Exercise workflow transitions and user-edited assets

**Status:** ready-for-agent
**Milestone:** 8 — Evaluation Completion
**Blocked by:** APS-043 — Trigger threshold gate.
**Dependency rationale:** Milestone 7 must complete first; this fixture slice does not require the separate mutation-matrix implementation.
**PRD requirements:** [PRD.md](../../../PRD.md) §22; §31 transition scenarios; §41 ordering.

**What to build:** Executable behavioral fixtures expose renamed, removed, split, merged, and user-edited-generated-Skill cases before destructive reconciliation is introduced.

## Scope and implementation boundaries

Extend the current fixture schema, matrix inventory, evidence-source checks, and local conforming-oracle patterns. Implement the five corresponding behavioral cases from the PRD's 16–20 range. Reuse representative repositories; do not expand language coverage or build a historical workflow database.

PRD.md remains the sole specification; §4–5 and §42 apply. This ticket supplies green evidence/decision scenarios under the currently supported action set. It must not enable RETIRE early, hardcode preservation as the eventual answer for all transitions, or claim that future pruning already works.

## Acceptance criteria

- [ ] Five fixtures independently represent rename, remove, split, merge, and a user-edited generated Skill, using concrete current repository evidence and existing Agent assets.
- [ ] Evidence and expected observations distinguish semantic continuity, actual replacement/removal, and mere inability to rediscover an old workflow.
- [ ] Each fixture has a valid schema, resolvable evidence sources, explicit current allowed actions, forbidden mutation boundaries, and a passing conforming oracle.
- [ ] Current non-destructive decision/preservation behavior is tested end to end; user edits cannot be silently overwritten or treated as deletion authorization.
- [ ] A meaningful isolated counterexample per case is rejected by the existing evaluator for the intended reason.
- [ ] No RETIRE action is introduced, no failing/skipped future-pruning test is committed, and future retirement expectations are not falsely marked satisfied.
- [ ] The same fixture evidence can be extended by M9 tickets for actual approved migration/retirement without replacing these scenarios.

## Verification

Run fixture schema/matrix, evidence checks, conforming oracles, and their mutations, then `npm test`. Verify all five scenarios execute rather than merely exist as data. Completion proves behavioral coverage under the current contract, not the later RETIRE implementation.
