# 04 — APS-038 — Apply immutable Action pinning consistently

**Status:** ready-for-agent
**Milestone:** 6 — Known Gap Closure
**Blocked by:** None — can start immediately.
**PRD requirements:** [PRD.md](../../../PRD.md) §10.

**What to build:** CI and release workflows use the same immutable pinning policy for every external GitHub Actions dependency without changing what their jobs do.

## Scope and implementation boundaries

Correct mutable external Action references in place. Reuse already-verified pins where the intended Action version is the same; otherwise verify the commit against the Action's authoritative upstream source. Keep readable version comments. A local action path is not an external version reference.

PRD.md remains the sole specification; §4–5 and §42 apply. Do not upgrade unrelated Actions, redesign workflows, add permissions, or broaden the platform matrix as part of pinning. Obtain the required approval before editing CI configuration. Do not add a generic dependency-management framework.

## Acceptance criteria

- [ ] Every external GitHub Actions dependency in CI and release is pinned to a full immutable commit SHA, not a mutable tag or branch.
- [ ] Each version comment corresponds to the pinned upstream commit; verification sources or reused verified pin evidence are recorded with completion evidence.
- [ ] CI and release use the same policy, with no overlooked job or workflow reference.
- [ ] Jobs retain their existing commands, triggers, permissions, and operating-system coverage except for the pin syntax itself.
- [ ] A focused repository check rejects a mutable external Action reference and accepts the conforming workflows, using existing test conventions rather than a new framework.

## Verification

Inventory all external workflow references, verify the pins, run the focused pinning check and `npm test`, and inspect the diff for accidental behavioral or permission changes. Perform a supply-chain/security review of the changed references. Distinguish local workflow checks from actual CI execution; do not claim cross-platform runs occurred unless their job evidence exists.
