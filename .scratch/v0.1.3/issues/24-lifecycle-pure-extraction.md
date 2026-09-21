# 24 — AI-058 — Extract only independently invariant lifecycle flows

**Status:** ready-for-agent
**Milestone:** 10 — Qualification
**Blocked by:** AI-057 — Evidence-backed qualification and traceability.
**Dependency rationale:** PRD §38 places maintainability extraction in the final stage, after correctness and safety behavior is established.
**PRD requirements:** [PRD.md](../../../PRD.md) §38.

**What to build:** A small, justified lifecycle extraction improves independent reasoning while preserving the public executeLifecycle interface and all existing observable behavior.

## Scope and implementation boundaries

Start with the existing lifecycle characterization and fault-injection suites. Identify a concrete flow boundary with an independently expressible invariant before moving code. Use only the minimum pure extraction that satisfies that boundary; the PRD's install/update/uninstall/recovery module list is permission, not a mandatory four-way split.

PRD.md remains the sole specification; §4–5 and §42 apply. Do not fix new behavior in this ticket, introduce compatibility wrappers, add a generic lifecycle framework, or split only to shorten a file. Any discovered correctness defect is reported separately rather than hidden inside mechanical extraction. If no independent boundary can be justified, report that constraint rather than inventing one or claiming an unperformed refactor.

## Acceptance criteria

- [ ] Characterization tests establish current successful, failed, interrupted/recovered, and user-asset-preserving behavior before production code is moved.
- [ ] The selected extracted flow has an explicit independent invariant and a bounded interface; dependencies remain understandable without one-layer forwarding wrappers.
- [ ] Public executeLifecycle arguments, return values, error behavior, and observable filesystem outcomes remain unchanged.
- [ ] The extraction is mechanical: no altered ownership policy, approval model, recovery ordering, platform behavior, or parent-cleanup semantics.
- [ ] The same characterization cases pass before and after, including AI-036's parent rollback and existing no-follow/race/crash coverage.
- [ ] No unrelated formatting sweep, module rewrite, framework, or forced four-file decomposition is included.
- [ ] Qualification/traceability references remain valid, with changed code requiring fresh final release checks rather than reuse of stale run evidence.

## Verification

Run characterization tests before extraction and preserve the results; run the same tests after, followed by `npm test` and relevant package/lifecycle checks. Inspect the diff for pure movement versus behavior changes and review the security/concurrency-sensitive boundaries. AI-059 reruns final cross-platform and exact-payload checks after this ticket.
