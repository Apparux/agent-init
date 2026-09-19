# 16 — APS-050 — Update Agent-plane references and retire in one approved Proposal

**Status:** ready-for-agent
**Milestone:** 9 — Safe Pruning
**Blocked by:** APS-049 — Skill bundle retirement.
**PRD requirements:** [PRD.md](../../../PRD.md) §28–30, §32.

**What to build:** A referenced obsolete Agent asset can be retired only when its incoming Agent-plane references are also safely updated within the same exact approved Proposal.

## Scope and implementation boundaries

Extend the bounded reference scan and existing UPDATE/RETIRE evaluation, rather than adding a repository-wide dependency graph or new approval mechanism. Reuse exact UPDATE payloads, Proposal digest/revision binding, identity/fingerprint revalidation, and actual filesystem delta checks. References outside the allowed Agent plane do not authorize business-source modification.

PRD.md remains the sole specification; §4–5 and §42 apply. Unknown or uninspectable reference state fails closed. Real deletions and protected configuration changes retain their separate backup/approval gates; tests run in disposable repositories.

## Acceptance criteria

- [ ] A RETIRE-only Proposal for a still-referenced asset is invalid and identifies the incoming reference impact.
- [ ] A valid Proposal includes exact UPDATE payloads for affected references plus the target RETIRE, with replacement information when applicable.
- [ ] Omitting a reference update, failing to approve one of the coordinated actions, or approving a different revision rejects application.
- [ ] The reference scan is limited to the PRD agent plane, does not follow escapes, and reports unreadable/ambiguous inputs instead of assuming safety.
- [ ] Apply revalidates target and affected-reference baselines and checks for newly introduced incoming references; relevant post-Proposal drift requires a new Proposal.
- [ ] Approved reference updates occur in a safe order before target retirement; an unsuccessful update cannot be followed by deletion that leaves its reference dangling.
- [ ] Success leaves valid references and an absent retired asset, with actual changes exactly matching approved actions.
- [ ] Failure reports actual partial state and does not claim rollback or all-or-nothing behavior that was not implemented and verified.
- [ ] Known-good document and Skill scenarios plus isolated omission, approval, reference-drift, and target-drift mutations pass their intended assertions.

## Verification

Exercise physical before/Proposal/pre-Apply/final snapshots for referenced docs and Skill bundles. Check final reference resolution and no unrelated delta, not only action logs. Extend the mutation matrix, run all affected tests and `npm test`, and review reference scope, ordering, race handling, and fail-closed behavior.
