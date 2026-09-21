# 14 — AI-048 — Retire one unreferenced obsolete Agent document safely

**Status:** ready-for-agent
**Milestone:** 9 — Safe Pruning
**Blocked by:** AI-044 — Mutation matrix; AI-045 — Transition fixtures; AI-046 — Ambiguous-evidence fixtures; AI-047 — Acceptance freshness.
**Dependency rationale:** All Milestone 8 work must complete before pruning under PRD §41.
**PRD requirements:** [PRD.md](../../../PRD.md) §24–30, §31.4.

**What to build:** A positively obsolete, unreferenced Agent document can be proposed, explicitly approved, retired, and verified absent through the existing mother-Skill workflow. This first destructive slice includes the entire safety contract, not just a new action label.

## Scope and implementation boundaries

Limit initial support to a single regular Agent document in the existing allowed Agent-doc scope, with no incoming agent-plane references. Extend mother-Skill instructions, Proposal/action validation, physical evaluator snapshots, fixture oracles, and mutation tests together. Reuse normalized-scope, fingerprint, Proposal digest, approval, and actual-delta checks. Entry identity is checked independently of content equality.

RETIRE becomes a mutation alongside CREATE/UPDATE; KEEP/SKIP/RECOMMEND remain non-write. Unsupported retirement kinds fail closed until subsequent slices implement them. Do not add a packaged project Apply API, hidden project ownership database, compatibility layer, or installer-manifest deletion authority.

PRD.md remains the sole specification; §4–5 and §42 apply. Implementation tests use disposable repositories. Actual deletion retains the user's required backup and explicit confirmation gates; approval of this implementation ticket is not approval to delete real project knowledge.

## Acceptance criteria

- [ ] Current positive evidence proves obsolescence; missing evidence alone results in KEEP plus warning, never RETIRE.
- [ ] Proposal displays target, reason, evidenceIds, current fingerprint and identity binding, reference impact, and replacement if any.
- [ ] Explicit approval binds the exact Proposal revision/digest and RETIRE action ID; no general setup approval or stale approval authorizes deletion.
- [ ] Before retirement, scan the PRD's bounded agent plane: root shared/Claude instructions, canonical/discovery Agent directories, and Agent docs. Any incoming reference rejects this initial unreferenced-only slice; an unreadable or unsafe scan cannot be treated as zero references.
- [ ] Apply rechecks normalized repository-relative target, allowed kind, physical containment, no symlink escape, entry identity, fingerprint, and approval. Any target or relevant reference drift stops and requires a fresh Proposal.
- [ ] Same-content replacement with a different entry identity is rejected; symlink target/ancestor and outside-scope targets are rejected without following them.
- [ ] Successful application removes exactly the approved target; the evaluator accepts final absence rather than applying CREATE/UPDATE's final-presence rule.
- [ ] Unapproved deletion, surviving approved target, unrelated filesystem delta, missing evidence, stale approval, and changed target/reference conditions each have a known-good/single-mutation test.
- [ ] Existing CREATE/UPDATE and preservation behavior remains green; unsupported Skill-tree retirement remains non-executable, not partially applied.

## Verification

Start with a physical known-good document retirement scenario from existing behavioral fixtures. Add each fail-closed counterexample and prove no protected asset changes on rejection. Run filesystem evaluator, fixture/oracle, approval and mutation suites, then `npm test`. Review evidence authority, bounded reference scanning, deletion scope, race windows, no-follow behavior, and partial-failure reporting before completion.
