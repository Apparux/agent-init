# 05 — AI-039 — Reconcile product document status with the implemented baseline

**Status:** ready-for-agent
**Milestone:** 6 — Known Gap Closure
**Blocked by:** None — can start immediately.
**PRD requirements:** [PRD.md](../../../PRD.md) §11, §40–41; user-approved ticket decomposition and PRD SSOT constraint.

**What to build:** A reader can distinguish the implemented historical baseline from the still-pending v0.1.3 work, without mistaking old roadmap statuses for current product state.

## Scope and implementation boundaries

Make only factual lifecycle/status corrections to existing product documentation. Preserve AI-001 through AI-034 as historical implementation history rather than reissuing, deleting, or mechanically checking off every old task. Current v0.1.3 requirements remain in PRD.md; do not edit, replace, or duplicate that spec.

The user approved splitting/merging the planned work into AI-035 through AI-059. Those IDs are ticket identities, not a rewrite of the PRD's illustrative §40 allocation. Requirement references use PRD sections and AC identifiers, so renumbering does not change product intent.

Follow PRD §4–5 and §42. Do not rewrite the design, expand documentation, or assert release qualification based solely on the existence of these tickets.

## Acceptance criteria

- [ ] The existing design document accurately identifies its implemented/maintained historical baseline rather than incorrectly presenting all existing work as unimplemented.
- [ ] The old task roadmap is explicitly historical; AI-001 through AI-034 and their useful historical content remain available.
- [ ] Status text distinguishes the current implemented release baseline from v0.1.3 work awaiting implementation and qualification.
- [ ] PRD.md remains unchanged and is not prematurely marked Released; there is no new competing specification.
- [ ] References to new work identify the approved sequential ticket set beginning with AI-035 without claiming that the PRD itself has been rewritten.
- [ ] No unverified release, test, or completion claim is introduced.

## Verification

Review the rendered/document text against package metadata, the existing implementation, and the historical roadmap. Check links and ticket numbering. Confirm PRD.md is unchanged, inspect the documentation-only diff, and run `npm test` to ensure the repository remains testable. This is a status correction, not evidence that v0.1.3 is released.

## Comments

### 2026-09-22 — Merged baseline: `bdf2999`

- Baseline to reconcile: package metadata is `0.1.3-rc.2`; merged commit `bdf2999` adds registry-driven installation, custom targets/aliases, and the `harnesses` command. Check `package.json`, `src/installation/harnesses.js`, and `src/cli/run.js` when updating status text.
- Remaining: `DESIGN.md` and `TASKS.md` still carry historical implementation/planning statuses. Distinguish merged capabilities from published payloads and release qualification; this commit does not establish a new publication or completion of the pending v0.1.3 requirements.
