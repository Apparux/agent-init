# 02 — APS-036 — Roll back operation-created discovery parents safely

**Status:** ready-for-agent
**Milestone:** 6 — Known Gap Closure
**Blocked by:** None — can start immediately.
**PRD requirements:** [PRD.md](../../../PRD.md) §8.1–8.4; AC-PAR01, AC-PAR02, AC-PAR03, AC-PAR04, AC-PAR05.

**What to build:** A failed fresh installation removes only empty discovery parents created by that same operation whose identities are unchanged. Existing or concurrently changed user directories survive with an actionable report.

## Scope and implementation boundaries

Reuse the existing operation createdParents slot, journal/recovery machinery, safe directory-chain creation, entry-identity checks, and installation fault injection. Carry ownership of creation through the operation rather than treating discovery parents as permanent installer assets. Keep normal uninstall semantics unchanged. Do not refactor lifecycle flows here or use recursive parent removal.

PRD.md remains the sole specification; §4–5 and §42 apply. Tests use isolated disposable homes, never the developer's actual discovery directories. Any unsafe or uncertain cleanup condition preserves the entry and reports context rather than silently swallowing errors.

## Acceptance criteria

- [ ] Each newly created parent records path, operationId, and entry identity in the existing transaction/recovery representation before it can be considered for rollback.
- [ ] Rollback revalidates the same path, same identity, directory type, emptiness, and current-operation creation; nested parents are considered in a safe child-before-parent order.
- [ ] Injected failure after parent creation in a fresh HOME removes eligible empty parents (AC-PAR01).
- [ ] A foreign file introduced before cleanup preserves its parent and is reported (AC-PAR02).
- [ ] Replacing a parent entry, including replacement by a symlink, preserves that entry and is reported (AC-PAR03).
- [ ] Pre-existing parents are always preserved (AC-PAR04).
- [ ] Successful normal uninstall preserves discovery parents (AC-PAR05).
- [ ] Existing crash/recovery paths retain the same ownership guarantees; no recovery path removes a parent whose creation or identity cannot be established.

## Verification

First reproduce the missing rollback with existing installation fault injection. Add foreign-content, identity-replacement, pre-existing-parent, and uninstall regressions. Run parent-race, installation, crash/recovery, and uninstall tests, then `npm test`. Review the final diff specifically for ownership, no-follow behavior, races, and suppressed errors. No real HOME mutation is part of verification.
