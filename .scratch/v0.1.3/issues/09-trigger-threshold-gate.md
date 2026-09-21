# 09 — AI-043 — Gate trigger qualification on measured routing thresholds

**Status:** ready-for-agent
**Milestone:** 7 — Real Trigger Qualification
**Blocked by:** AI-041 — Claude Code live acceptance; AI-042 — Codex live acceptance.
**PRD requirements:** [PRD.md](../../../PRD.md) §18, §39, §43.

**What to build:** A complete set of real acceptance records produces an explainable trigger pass/fail decision using the PRD thresholds, without hiding failed cases or substituting local evaluator success for external routing evidence.

## Scope and implementation boundaries

Extend the existing acceptance result evaluator with focused aggregation. Use the versioned corpus and explicit invocation probes as the declared run inventory. Preserve Harness-specific results so one Harness cannot mask failures in the other. Do not introduce numerical Skill scoring, a statistical framework, or thresholds stricter/weaker than the PRD.

PRD.md remains the sole specification; §4–5 and §42 apply. This is an intermediate trigger gate, not a declaration that the whole release is Qualified. AI-047 adds full current-payload freshness enforcement; AI-059 consumes the final complete gate.

## Acceptance criteria

- [ ] Explicit invocation must be 100%; positive implicit routing at least 95%; negative false activation at most 2%; collision/multi-Skill routing at least 90%, for both required Harnesses.
- [ ] Category membership and denominators are explicit and reproducible from the corpus/run inventory, including near-miss no-load expectations in negative-routing evaluation rather than silently omitting them.
- [ ] The normal run evaluates every required case; any repetition policy is fixed before execution, and all declared attempts count. Retries cannot cherry-pick successful observations or silently replace failures within a run.
- [ ] Missing records, unavailable Harness execution, duplicate/ambiguous records, malformed artifacts, and absent required categories prevent a passing qualification result.
- [ ] Output shows counts, denominators, Harness identity, and failed case IDs/expectations, not only a boolean.
- [ ] Boundary tests establish inclusive comparisons at 100%, 95%, 2%, and 90%, and rejection just outside each boundary without rounding a failing value into a pass.
- [ ] Real artifacts from both runners can be evaluated; threshold failures remain failures until a complete valid rerun demonstrates the requirements.

## Verification

Test complete and incomplete runs, threshold boundaries, near misses, collisions, and anti-cherry-picking behavior using synthetic evaluator inputs. Evaluate the actual runner artifacts separately and report their measured outcomes. Run `npm test`. No final release claim is permitted from this ticket alone.
