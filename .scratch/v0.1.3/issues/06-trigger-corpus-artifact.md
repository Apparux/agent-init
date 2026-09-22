# 06 — AI-040 — Evaluate versioned trigger cases through acceptance artifacts

**Status:** ready-for-agent
**Milestone:** 7 — Real Trigger Qualification
**Blocked by:** AI-035 — Routing metadata; AI-036 — Parent rollback; AI-037 — Version SSOT; AI-038 — Action pinning; AI-039 — Document status.
**Dependency rationale:** All Milestone 6 work must finish before Milestone 7 starts, as required by PRD §41; metadata is also a direct input to trigger evaluation.
**PRD requirements:** [PRD.md](../../../PRD.md) §13–15, §19.

**What to build:** A version-controlled trigger case and a recorded acceptance artifact can be evaluated together to produce a reproducible expected-versus-observed result. Corpus and artifact structure are delivered with a working consumer, not as disconnected schemas.

## Scope and implementation boundaries

Use existing fixture IDs, generated-Skill conventions, digest utilities, evaluator patterns, and Node standard library. Keep shared preparation/digest/result logic small enough for the two concrete Harness runners to reuse. Do not introduce a generic Agent framework, statistical framework, or new project Apply API.

PRD.md remains the sole specification; §4–5 and §42 apply. Synthetic artifacts are test inputs only, not real external acceptance. Keep credentials, private HOME contents, and unrelated conversation data out of committed corpus and artifacts.

## Acceptance criteria

- [ ] Each generated Skill selected for real acceptance has positive, negative, near-miss, and collision prompts, with stable case/fixture identity and explicit mustLoad/mustNotLoad expectations.
- [ ] Cases identify their category so later aggregation does not infer it from prompt wording; contradictory or unknown expectations are rejected.
- [ ] Corpus data is tracked in the repository and uses the existing behavior fixtures rather than invented technology coverage.
- [ ] The artifact validator requires schemaVersion, supported harness, harnessVersion, fixtureId, caseId, expected, observed.loaded, result, recordedAt, and mother/generated Skill, fixture, and trigger-corpus digests.
- [ ] For multi-Skill cases, the generated payload digest binds the relevant generated Skill set deterministically, so changing any contributing Skill changes the digest.
- [ ] The evaluator checks the authoritative corpus expectations against observed selection; forged expected values, mismatched case/fixture identity, and a claimed pass inconsistent with observations fail.
- [ ] Missing or unparseable selection evidence cannot be treated as a genuine empty loaded list; a valid observed empty list remains valid for an appropriate negative case.
- [ ] One conforming artifact passes and isolated schema, identity, expectation, and result mutations fail for the intended reason.

## Verification

Test the complete case-to-artifact-to-result path with existing fixture builders and explicit synthetic test inputs. Run focused corpus/artifact tests and `npm test`. No live Harness claim is made here; AI-041 and AI-042 supply real observations, and AI-047 enforces comparison with the current payload.

## Comments

### 2026-09-22 — Merged baseline: `bdf2999`

- Boundary: `src/installation/harnesses.js` now lists six install targets and supports custom configuration. Its static verification labels describe registry entries, not current-payload live routing evidence.
- Keep this ticket's two concrete acceptance runners scoped to Claude and Codex (AI-041/042). Installation/discovery tests do not replace the corpus-to-observed-selection artifact contract or authorize expanding live qualification to every registry entry.
