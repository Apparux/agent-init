# 21 — AI-055 — Validate knowledge placement across context layers

**Status:** ready-for-agent
**Milestone:** 10 — Qualification
**Blocked by:** AI-054 — Pruning idempotency.
**Dependency rationale:** The completed M9 gate precedes M10 under PRD §41.
**PRD requirements:** [PRD.md](../../../PRD.md) §34; §5.3–5.4.

**What to build:** The evaluator verifies that generated knowledge belongs in its chosen persistence layer, using classification and evidence rather than a word-count proxy.

## Scope and implementation boundaries

Extend existing Knowledge Classification, Evidence Ledger, candidate, and final-asset checks. Reuse conflict/overlap/stale/partial-evidence fixtures and the existing mutation matrix. Agent understanding supplies semantic decisions; deterministic checks verify supported classifications, evidence, approved content, and observable contracts. Do not create a general semantic classifier or LLM judging framework.

PRD.md remains the sole specification; §4–5 and §42 apply. This ticket verifies layer responsibilities; AI-056 adds the distinct cross-layer duplication matrix. Do not rewrite all generated content or impose arbitrary size quotas to make a test pass.

## Acceptance criteria

- [ ] Shared global instructions contain GLOBAL knowledge and high-value pointers rather than large amounts of DISCOVERABLE implementation detail.
- [ ] The Claude adapter does not independently restate shared policy; any Claude-specific content requires corresponding Claude-specific evidence.
- [ ] Project Skills are WORKFLOW-scoped and task-specific, evidence-backed, complete in routing metadata, and include observable verification.
- [ ] Agent docs contain durable deep architecture or complex reference knowledge rather than a second global prompt dump.
- [ ] Known-good classification/evidence examples pass; each inappropriate placement or unsupported Harness-specific exception has an isolated failing case.
- [ ] Legitimate pointer-based progressive disclosure remains valid; no simple word count substitutes for a semantic/evidence boundary.
- [ ] Existing approval, generated-byte, pruning, and routing invariants remain intact.

## Verification

Run the relevant physical fixture/evaluator examples and placement mutations, then `npm test`. Check that diagnostics identify the violated layer contract and evidence, not just length or keyword matches. Record evidence for the contextArchitecture qualification dimension without declaring the whole release qualified.
