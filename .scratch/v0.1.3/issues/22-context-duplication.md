# 22 — APS-056 — Detect unnecessary context and Skill discovery duplication

**Status:** ready-for-agent
**Milestone:** 10 — Qualification
**Blocked by:** APS-055 — Context architecture contract.
**PRD requirements:** [PRD.md](../../../PRD.md) §35, §21.

**What to build:** Cross-layer duplication is rejected without confusing legitimate pointers, shared names, or canonical discovery references with copied knowledge.

## Scope and implementation boundaries

Extend the existing duplicate-rule/canonical-sharing evaluator using the evidence and placement contract completed by APS-055. Reuse overlap/conflict fixtures and filesystem-backed canonical/discovery assertions. Keep analysis bounded to current Agent assets; do not add a generic semantic similarity engine, scoring system, arbitrary token cap, or new dependency.

PRD.md remains the sole specification; §4–5 and §42 apply. Classification and evidence inform semantic boundaries; text equality alone is insufficient for every duplication class. Do not automatically delete detected duplicates as part of validation.

## Acceptance criteria

- [ ] The evaluator covers shared instructions versus Claude adapter duplication.
- [ ] It covers unnecessary shared-instruction versus Skill duplication and wholesale Skill versus Agent-doc duplication.
- [ ] It covers duplicate canonical Skills and duplicate Claude Skill copies/references, preserving the existing valid single-source discovery layout.
- [ ] Each of the five PRD duplication classes has a known-good case and a single intentional mutation producing the intended failure.
- [ ] Legitimate pointers, canonical symlink/reference relationships, common names, and small necessary shared phrases do not fail solely because text overlaps.
- [ ] Diagnostics identify the assets and contract involved, allowing an exact approved correction rather than automatic pruning.
- [ ] Existing context placement, approved-byte, and discovery consistency tests remain green.

## Verification

Run the five positive/negative pairs and relevant physical canonical/discovery tests, then `npm test`. Review both false-negative and false-positive examples. Record the executable evidence consumed later by qualification; do not replace semantic boundaries with simple word-count limits.
