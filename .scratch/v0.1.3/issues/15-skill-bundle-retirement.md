# 15 — AI-049 — Retire an obsolete Skill bundle and its discovery reference

**Status:** ready-for-agent
**Milestone:** 9 — Safe Pruning
**Blocked by:** AI-048 — Safe unreferenced document retirement.
**PRD requirements:** [PRD.md](../../../PRD.md) §24–30; §35 canonical/discovery consistency.

**What to build:** An obsolete canonical project Skill and its corresponding Claude discovery reference can be retired together without leaving a dangling reference or deleting unapproved content.

## Scope and implementation boundaries

Extend the existing complete RETIRE path to the canonical Skill tree and the project's existing supported discovery-reference representation. Preserve all evidence, approval, identity, containment, and reference checks from AI-048. Treat the pair as one coordinated Proposal scope, not as permission to delete every similarly named Skill.

Use existing tree-digest and no-follow identity primitives, not installer manifest ownership. Do not delete only the Skill entry document while leaving its approved bundle's references/scripts behind. External incoming references other than the explicitly handled discovery relationship still block this slice; AI-050 supports their coordinated updates.

PRD.md remains the sole specification; §4–5 and §42 apply. Deletion tests use disposable repositories; real asset deletion requires the user's backup/confirmation procedure. No new generic transaction engine or project Apply API is authorized.

## Acceptance criteria

- [ ] Proposal visibly binds the canonical tree contents/digest and identity plus the exact discovery reference/copy state and intended changes.
- [ ] Both parts receive exact action-level approval; approving only one cannot execute the full bundle retirement.
- [ ] Adding, editing, removing, or replacing a tree entry after Proposal generation stops retirement; same-bytes identity replacement is also rejected.
- [ ] Discovery handling does not follow a symlink into its target for deletion, and external targets/unsafe ancestors are preserved.
- [ ] The explicitly approved discovery relationship is handled in dependency-safe order; additional incoming references reject retirement.
- [ ] Success leaves neither the obsolete canonical bundle nor its obsolete discovery entry, with no unrelated delta.
- [ ] Partial failure is reported with actual remaining state, never as success; the sequence does not knowingly leave a surviving discovery entry pointing at an already-removed canonical tree.
- [ ] Physical success and refusal cases extend the mutation matrix; existing document retirement and CREATE/UPDATE paths stay green.

## Verification

Test canonical tree contents, supported discovery representations, foreign additions, identity changes, dangling-reference prevention, and failures between approved steps in disposable repositories. Run focused retirement/filesystem tests and `npm test`. Review deletion ordering, no-follow behavior, and ownership assumptions. Do not introduce recursive deletion of a discovery parent.

## Comments

### 2026-09-22 — Merged baseline: `bdf2999`

- Separate planes: `bdf2999` adds removal of manifest-owned HOME discovery targets after their harness configuration disappears; see `tests/installation/registry-compat.test.js`. That installer uninstall behavior does not satisfy project Skill bundle RETIRE acceptance.
- Remaining: project-level obsolescence evidence, exact coordinated Proposal approval, incoming-reference checks, and identity/drift refusal. `tests/agent-init/evaluation-harness.js` and `skills/agent-init/references/reconciliation-guidelines.md` still use the CREATE/UPDATE write contract. Extend AI-048's project retirement path rather than borrowing installer manifest ownership.
