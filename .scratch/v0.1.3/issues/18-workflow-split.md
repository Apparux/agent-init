# 18 — APS-052 — Reconcile a workflow split within one approved Proposal

**Status:** ready-for-agent
**Milestone:** 9 — Safe Pruning
**Blocked by:** APS-050 — Coordinated reference updates and retirement.
**PRD requirements:** [PRD.md](../../../PRD.md) §31.2, §7, §28–30.

**What to build:** An obsolete combined workflow is replaced by two evidence-backed workflows, with the new assets, references, and old retirement visible and approved together.

## Scope and implementation boundaries

Extend the existing split fixture and mother-Skill reconciliation decisions. Reuse candidate generation, routing validation, coordinated approval, and safe RETIRE. This ticket does not depend on rename implementation and must not invent a generic migration planner or add speculative workflow candidates.

PRD.md remains the sole specification; §4–5 and §42 apply. The old Skill is not retired merely because two names can be proposed. Real deletion remains explicitly approved and backed up; only disposable assets are mutated by tests.

## Acceptance criteria

- [ ] Current evidence establishes both new workflows and why the old combined knowledge is obsolete.
- [ ] One exact Proposal contains both new workflows' establishment, required reference/discovery changes, and the old asset's retirement.
- [ ] Partial approval cannot execute the full migration or retire the old workflow while required replacements are unapproved/unestablished.
- [ ] Both generated Skills satisfy metadata, evidence, exact payload, workflow scope, and observable verification contracts.
- [ ] Target or reference drift invalidates the relevant Proposal before unsafe mutation; any failure reports actual state and cannot falsely claim a completed split.
- [ ] Success leaves both expected workflows discoverable, no obsolete/orphan Skill, valid references, and no unrelated changes.
- [ ] Missing replacement evidence and incomplete coordinated approval produce isolated, verifiable refusals.

## Verification

Extend the split fixture through full Proposal, approval, physical Apply snapshots, and final evaluation. Test incomplete approval, missing evidence, and mutation drift; extend the invariant matrix. Run focused reconciliation/fixture tests and `npm test`. APS-054 supplies the second-run zero-write acceptance across transition types.
