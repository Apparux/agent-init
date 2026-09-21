# 19 — AI-053 — Reconcile a workflow merge without orphan Skills

**Status:** ready-for-agent
**Milestone:** 9 — Safe Pruning
**Blocked by:** AI-050 — Coordinated reference updates and retirement.
**PRD requirements:** [PRD.md](../../../PRD.md) §31.3, §7, §28–30.

**What to build:** Multiple replaced workflows converge into one evidence-backed workflow while all obsolete assets and incoming references are handled in one exact approved migration.

## Scope and implementation boundaries

Use the existing merged fixture, candidate evidence, generated-Skill contract, and coordinated UPDATE/RETIRE protocol. Keep reasoning in mother-Skill instructions and validation in the current evaluator. Do not create a generic merge engine or consolidate Skills simply because their wording overlaps.

PRD.md remains the sole specification; §4–5 and §42 apply. Evidence must support the actual merged workflow and every obsolete predecessor. Tests mutate only disposable assets; real asset retirement requires explicit backup/approval.

## Acceptance criteria

- [ ] Evidence establishes the merged workflow and identifies which old workflows it replaces; overlap alone does not prove obsolescence.
- [ ] One Proposal contains the merged target payload, all required reference/discovery updates, and each old asset's disposition.
- [ ] Exact approval covers every mutation; a missing approval or post-Proposal identity/fingerprint/reference change prevents unsafe application.
- [ ] The resulting Skill passes routing, evidence, exact-byte, and verification contracts.
- [ ] Successful final state contains the expected canonical workflow, no orphan predecessors or duplicate discovery entries, valid references, and no unrelated delta.
- [ ] Omitting one predecessor, leaving an incoming reference, or falsely asserting replacement evidence is detected by focused counterexamples.
- [ ] Any interrupted migration reports its actual state and never claims completed merge or unverified rollback.

## Verification

Extend the merged fixture from decision through exact approval and physical final-state evaluation. Add missing-predecessor, incomplete-approval, evidence, and drift mutations. Run reconciliation/fixture/mutation tests and `npm test`. Do not require rename or split code unless actual shared behavior already exists; reuse the prior coordinated-retirement contract.
