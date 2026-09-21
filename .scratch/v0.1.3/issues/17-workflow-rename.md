# 17 — AI-051 — Reconcile workflow renames as semantic continuity

**Status:** ready-for-agent
**Milestone:** 9 — Safe Pruning
**Blocked by:** AI-050 — Coordinated reference updates and retirement.
**PRD requirements:** [PRD.md](../../../PRD.md) §31.1, §5.1; existing §7 and §28–30 contracts.

**What to build:** A workflow whose name changes is recognized as the same continuing workflow and receives the smallest evidence-backed migration Proposal, rather than being independently recreated and retired.

## Scope and implementation boundaries

Extend mother-Skill reconciliation guidance, existing candidate identity/evidence, and the renamed behavioral fixture. The Agent reasons about semantic continuity; deterministic checks validate scope, payload, approval, and final state. Reuse the existing action vocabulary and approved mutation protocol; do not introduce a global identity registry, MOVE compatibility layer, or semantic scoring engine.

PRD.md remains the sole specification; §4–5 and §42 apply. Distinguish semantic migration from whatever minimal approved physical changes the existing representation needs. Do not force a rename merely to normalize names, discard user edits, or migrate unrelated Skills.

## Acceptance criteria

- [ ] The renamed fixture demonstrates evidence-backed continuity of the workflow rather than two unrelated candidates.
- [ ] Proposal explains continuity and contains only necessary content/name/discovery/reference changes; no mechanical independent CREATE-new/RETIRE-old decision substitutes for that reasoning.
- [ ] Resulting Skill name, directory, description, and approved bytes satisfy the routing contract.
- [ ] User edits and baseline identity/fingerprint changes remain protected; approval of the semantic goal does not authorize an unspecified payload.
- [ ] Successful migration leaves one canonical workflow representation, valid discovery, and no stale references or unapproved delta.
- [ ] A genuinely unrelated workflow is not falsely treated as a rename; missing continuity evidence is not permission to delete the original.
- [ ] Existing document/Skill retirement tests remain green and new reconciliation invariants receive targeted mutation coverage.

## Verification

Extend the existing renamed fixture with a complete proposed/approved/applied migration and physical final-state validation. Add a non-continuity counterexample and edited-asset/drift refusal cases. Run reconciliation, fixture, mutation tests and `npm test`. Broader second-run pruning coverage is delivered by AI-054.
