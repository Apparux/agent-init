# 12 — APS-046 — Exercise conflicting, stale, overlapping, and partial evidence

**Status:** ready-for-agent
**Milestone:** 8 — Evaluation Completion
**Blocked by:** APS-043 — Trigger threshold gate.
**Dependency rationale:** Milestone 7 must complete first; these fixtures are independent of the transition-fixture slice.
**PRD requirements:** [PRD.md](../../../PRD.md) §22, §26–27, §42.

**What to build:** Four executable fixtures challenge knowledge decisions when Agent instructions conflict, architecture knowledge is stale, Skills overlap, or workflow evidence is incomplete.

## Scope and implementation boundaries

Add the four corresponding scenarios from the PRD's 21–24 range using the existing fixture/evidence/oracle conventions. Test decision difficulty, not language count. Keep all cases green under the current supported actions before M9 begins.

PRD.md remains the sole specification; §4–5 and §42 apply. Do not invent a deterministic semantic rule engine, silently resolve uncertain facts, enable deletion, or treat missing evidence as obsolescence. Later pruning/context tickets extend these fixtures rather than creating competing fixture frameworks.

## Acceptance criteria

- [ ] There is a distinct fixture and oracle for conflicting Agent instructions, stale architecture documentation, overlapping Skills, and a partially evidenced workflow.
- [ ] Each case has real fixture-local evidence and identifies which conclusions are supported, contradicted, or unknown.
- [ ] Positive evidence that knowledge is obsolete is distinguishable from inability to reconfirm that knowledge.
- [ ] Incomplete evidence preserves existing knowledge with a warning; it neither manufactures project facts nor authorizes deletion.
- [ ] User-authored/edited assets and unrelated source remain protected, including when instructions conflict.
- [ ] Conforming current decisions pass and targeted unsupported-evidence or unsafe-mutation counterexamples fail.
- [ ] Fixture inventory/schema checks include all new scenarios; no disabled tests or premature RETIRE acceptance claims are used.

## Verification

Run evidence-source validation, fixture matrix and oracle tests, relevant preservation/evidence mutations, and `npm test`. Inspect each oracle against the repository facts, not only its declared expected action. Report the tested uncertainty boundaries explicitly.
