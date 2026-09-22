# 13 — AI-047 — Reject acceptance for stale release inputs

**Status:** ready-for-agent
**Milestone:** 8 — Evaluation Completion
**Blocked by:** AI-043 — Trigger threshold gate.
**Dependency rationale:** The existing dual-Harness gate and digest-bearing artifacts are the direct prerequisites; Milestone 7 must be complete.
**PRD requirements:** [PRD.md](../../../PRD.md) §19, §39; §40 Milestone 8 freshness requirement.

**What to build:** A previously passing external acceptance becomes stale when any bound release input changes, and the trigger/release gate requires a new real run for the current payload.

## Scope and implementation boundaries

Compare the AI-040 artifact bindings against independently computed current mother Skill, generated Skill set, fixture, and corpus digests. Reuse existing canonical digest logic and artifact validation. Do not create a cache invalidation framework, timestamp-based substitute for content identity, or compatibility path for old incomplete artifacts.

PRD.md remains the sole specification; §4–5 and §42 apply. Historical evidence remains historical; never rewrite its digests to make it current. No live rerun or credential use is implicitly authorized by adding the validator.

## Acceptance criteria

- [ ] Four isolated tests change exactly one bound input: mother Skill, generated Skill, fixture, or trigger corpus; each marks the previously valid artifact stale.
- [ ] An unchanged complete payload remains current, subject to normal acceptance validation.
- [ ] Missing/unreadable required bindings or inability to establish the current payload prevent qualification and identify the affected evidence.
- [ ] Both Claude and Codex acceptance are checked; one current Harness does not excuse stale evidence for the other.
- [ ] The trigger gate rejects stale records and reports which real acceptance must be rerun, even when their recorded result and thresholds were previously passing.
- [ ] Collision cases bind the contributing generated Skill set, so modifying a non-primary participating Skill also invalidates acceptance.
- [ ] Single-mutation freshness cases join the existing evaluator mutation pattern; no final gate can consume a stale pass as current evidence.

## Verification

Run digest/validator and trigger-gate tests, including unchanged positive controls and each independent mutation, then `npm test`. Use synthetic test evidence only for validator testing; retain the provenance of any actual external records. Confirm failure messages distinguish stale inputs from observed routing failures.

## Comments

### 2026-09-22 — Merged baseline: `bdf2999`

- Reuse boundary: `scripts/release-manifest.js` checks the packed package tree against `release-manifest.json`. This distribution-integrity check does not implement the four acceptance bindings required here.
- Remaining: independently bind mother Skill, generated Skill set, fixture, and trigger corpus; reject stale Claude or Codex acceptance. Preserve historical run provenance and retain all single-input mutation cases.
