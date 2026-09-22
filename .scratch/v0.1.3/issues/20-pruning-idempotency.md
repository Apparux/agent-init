# 20 — AI-054 — Prove zero-write reconcile after pruning

**Status:** ready-for-agent
**Milestone:** 9 — Safe Pruning
**Blocked by:** AI-051 — Workflow rename; AI-052 — Workflow split; AI-053 — Workflow merge.
**Dependency rationale:** These incorporate the prerequisite document, Skill, remove, and reference-retirement paths; all must be covered before the M9 completion gate.
**PRD requirements:** [PRD.md](../../../PRD.md) §26, §31–32, §43.

**What to build:** After a successful approved retirement or migration, running agent-init again recognizes the stable repository and performs no mutations.

## Scope and implementation boundaries

Extend the existing secondRun and physical tree/delta checks across the completed pruning scenarios. Reuse prior fixtures, rather than inventing an idempotency cache, ownership database, or bypass that skips repository analysis on repeat runs.

PRD.md remains the sole specification; §4–5 and §42 apply. Fix only behavior directly necessary for the stated zero-write requirement. Do not hide unstable decisions by filtering action logs or ignoring writes.

## Acceptance criteria

- [ ] Document retirement, canonical Skill removal with no replacement, coordinated reference retirement, rename, split, and merge each complete an approved first reconcile and an independently evaluated second reconcile.
- [ ] Every stable second run has CREATE=0, UPDATE=0, RETIRE=0, and writes=0.
- [ ] Physical before/after evidence confirms no byte, entry, discovery, or reference mutation, rather than trusting self-reported counters.
- [ ] Retired assets are not regenerated; names and references do not oscillate or receive formatting-only rewrites.
- [ ] Missing-evidence KEEP plus warning and user-edited-asset preservation remain non-destructive on repeat runs.
- [ ] A deliberately introduced second-run write or retired-asset recreation fails the evaluator for the intended reason.
- [ ] All earlier approved payload, identity, evidence, and reference-safety regressions remain green.

## Verification

Run each scenario twice through the existing reconcile/evaluator protocol with independent physical snapshots. Inspect actual deltas and action counts, extend mutation coverage, and run `npm test`. Record which scenarios demonstrate idempotency; no mocked self-reported zero alone satisfies completion.
