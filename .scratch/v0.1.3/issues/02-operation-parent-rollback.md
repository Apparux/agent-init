# 02 — AI-036 — Roll back operation-created discovery parents safely

**Status:** ready-for-human
**Milestone:** 6 — Known Gap Closure
**Blocked by:** None — can start immediately.
**PRD requirements:** [PRD.md](../../../PRD.md) §8.1–8.4; AC-PAR01, AC-PAR02, AC-PAR03, AC-PAR04, AC-PAR05.

**What to build:** A failed fresh installation removes only empty discovery parents created by that same operation whose identities are unchanged. Existing or concurrently changed user directories survive with an actionable report.

## Scope and implementation boundaries

Reuse the existing operation createdParents slot, journal/recovery machinery, safe directory-chain creation, entry-identity checks, and installation fault injection. Carry ownership of creation through the operation rather than treating discovery parents as permanent installer assets. Keep normal uninstall semantics unchanged. Do not refactor lifecycle flows here or use recursive parent removal.

PRD.md remains the sole specification; §4–5 and §42 apply. Tests use isolated disposable homes, never the developer's actual discovery directories. Any unsafe or uncertain cleanup condition preserves the entry and reports context rather than silently swallowing errors.

## Acceptance criteria

- [x] Each newly created parent records path, operationId, and entry identity in the existing transaction/recovery representation before it can be considered for rollback.
- [x] Rollback revalidates the same path, same identity, directory type, emptiness, and current-operation creation; nested parents are considered in a safe child-before-parent order.
- [x] Injected failure after parent creation in a fresh HOME removes eligible empty parents (AC-PAR01).
- [x] A foreign file introduced before cleanup preserves its parent and is reported (AC-PAR02).
- [x] Replacing a parent entry, including replacement by a symlink, preserves that entry and is reported (AC-PAR03).
- [x] Pre-existing parents are always preserved (AC-PAR04).
- [x] Successful normal uninstall preserves discovery parents (AC-PAR05).
- [x] Existing crash/recovery paths retain the same ownership guarantees; no recovery path removes a parent whose creation or identity cannot be established.

## Verification

First reproduce the missing rollback with existing installation fault injection. Add foreign-content, identity-replacement, pre-existing-parent, and uninstall regressions. Run parent-race, installation, crash/recovery, and uninstall tests, then `npm test`. Review the final diff specifically for ownership, no-follow behavior, races, and suppressed errors. No real HOME mutation is part of verification.

## Comments

### 2026-09-22 — Merged baseline: `bdf2999`

- Baseline: `bdf2999` adds registry/custom discovery paths, including nested parents. Reuse `src/installation/paths.js`, `src/installation/targets.js`, and `src/installation/transaction.js` when implementing creation ownership.
- Remaining: operation-bound parent identity tracking and safe cleanup/reporting are still required. `tests/installation/registry-compat.test.js` covers created-target rollback, not parent reclamation. Cover registry/custom parent chains and assess the shared creation path used by reconcile without changing normal uninstall parent preservation.

### 2026-09-26 — Implemented locally; awaiting authorized integration

- Baseline: `0096a50ee7a2318c14d3c8c46b109aa3165f49a1`, verified by `git fetch origin main` and `git ls-remote origin refs/heads/main` before worktree creation. No prerequisite tickets; `bdf2999` is an ancestor and its directory-chain/registry mechanisms were verified in this baseline. No work from another session was copied or integrated.
- Isolation: branch `implement/v0.1.3-ticket-02`, worktree `.claude/worktrees/v0.1.3-ticket-02`. All implementation, tests and review performed there. Changes remain uncommitted by explicit request; no push, merge, PR or publication. Status is `ready-for-human` for the remaining authorization/integration handoff, not a claim of upstream completion.
- Implementation: `paths.js` records creation intent/completion through callbacks supplied by `targets.js`; completion binds path, operationId and entry identity, while EEXIST never grants ownership. `transaction.js` restores operation-created parent records on resume. Rollback validates the journal, allowed discovery chains, no-follow ancestors, operation-created ancestor identities, leaf identity/type and emptiness; deletion is child-first, nonrecursive `rmdir` only. Unsafe or uncertain entries remain with preserved/unresolved paths and remediation. Fresh-install, repair and reconcile failure paths share cleanup; fresh/reconcile recovery retains checkpoints and resumes parent cleanup without claiming absent/replaced entries. Parents never become permanent manifest-owned assets, and successful uninstall behavior remains unchanged.
- TDD evidence: the initial injected fresh-install failure reproduced retained empty parents; missing recovery-action handling, reconcile/repair parent cleanup and all three review defects were separately reproduced before fixes. New behavior tests are in `tests/installation/parent-rollback.test.js`, through `executeLifecycle`, real temporary HOME directories, runtime fault hooks and actual child-process termination/journal recovery.

#### Acceptance evidence (local macOS / Node v25.9.0)

| Requirement | Evidence in `tests/installation/parent-rollback.test.js` | Result |
|---|---|---|
| Creation ownership and durable recovery representation | `recovery reclaims journal-owned empty discovery parents after an interrupted install`; malformed operationId/path/identity/null-record cases; `recovery preserves a parent created before its identity completion was durable` | Passed |
| Identity/no-follow checks and child-before-parent cleanup | replaced operation-created ancestor; replaced symlink ancestor; deepest-parent interruption/resume; nested custom reconcile | Passed |
| AC-PAR01 | `failed fresh install removes its empty discovery parent chain` | Passed |
| AC-PAR02 | foreign-file preservation/reporting; same-process retry after resolving foreign content | Passed |
| AC-PAR03 | directory/symlink replacement; `replacement during parent creation is never adopted as operation-owned` | Passed |
| AC-PAR04 | pre-existing empty parents; `EEXIST during parent creation never grants rollback ownership` | Passed |
| AC-PAR05 | `successful uninstall retains discovery parents created by the successful install` | Passed |
| Crash/recovery ownership guarantees | fresh/reconcile recovery, second interruption, interrupted deepest rmdir, throwing checkpoint retention/retry, missing durable identity, legacy journals without creation evidence | Passed for exercised safety scenarios |

#### Verification and review

- `node --test tests/installation/parent-rollback.test.js tests/installation/parent-race.test.js`: **30 passed, 0 failed** after review fixes.
- `node --test tests/installation/parent-rollback.test.js tests/installation/crash-recovery.test.js`: **29 passed, 0 failed** at the earlier recovery slice; final full suite below re-executed these with all later changes.
- `node --check` for the four changed installation modules and the new test file: **passed**. No repository typecheck command exists; no toolchain/dependency was added.
- Final `npm test`: **205 tests, 203 passed, 0 failed, 2 skipped**. Includes installation, crash/recovery, parent-race, registry compatibility, uninstall and packed-artifact lifecycle tests. The skips are the two Windows Native tests on macOS; native Windows/Linux execution was not performed and is not claimed.
- `/code-review`: fixed baseline above, `git diff BASE_SHA --` plus all untracked files (not empty three-dot history). Standards: no hard violations or actionable smells. Spec/ownership review found three defects: creation-hook identity adoption, checkpoint exceptions discarding recovery evidence, and parent errors masking unresolved assets. Each received a red/green regression and a fix; both reviewers confirmed their respective fixes in a targeted read-only re-review. No unresolved finding introduced by this ticket remained in that review.
- `node scripts/release-manifest.js` followed by `node scripts/release-manifest.js --check`: **passed**, 23 entries, `sha256:cf654924b8624906b6020d4a12a51f3306145b4298ee5b14775118440c4920cd`. Temporary pack/unpack paths were checked before use; no publishing occurred. The manifest is derived and must be regenerated from the final combined source during integration, not hand-merged.

#### Boundaries and handoff

- Standard Node `mkdir → lstat` and `lstat → rmdir` are not atomic identity-conditioned filesystem operations. This implementation immediately revalidates observable interference and never uses recursive parent deletion, but does not claim protection against arbitrary hostile replacement between syscalls. This limitation was disclosed in the approved implementation plan; deterministic fault tests are not proof of atomic race freedom.
- A separate pre-existing limitation was identified by static inspection: `recoverInterruptedReconcile` uses `intent.targetId !== undefined` to select its symlink recovery branch even though reconcile intents carry targetId for copy fallback too. This can conservatively reject managed-copy reconcile recovery; it does not authorize parent deletion. It was not repaired or independently reproduced here, and this ticket does not claim all historical lifecycle recovery behaviors are fixed. Interrupted repair cases unsupported by the existing fresh-install validator likewise remain conservative, not newly authorized for cleanup.
- Local implementation and the listed acceptance checks are complete; cross-platform execution and combined-main validation remain unperformed. Integration readiness means ready for an explicitly authorized integration session to inspect/apply this uncommitted work, resolve any shared `src/installation/*` or `release-manifest.json` changes, regenerate the manifest and rerun validation. No automatic next ticket.
- Review and conclusions are based only on local repository context and the baseline Git remote verification, without external web research.

### 2026-09-26 — Follow-up local integration authorization

The user subsequently authorized committing ticket 02 and integrating it into local `main`, with verification, stopping before push. Earlier uncommitted handoff statements describe the prior state. Push, PR creation and publishing remain unauthorized.

Read-only preflight found local `main` and ticket 01 at `442b4fcdf441263dd582d3b145b3a36502b85084`; ticket 01 has no uncommitted changes, and the main checkout has no tracked/staged changes (only retained `.claude/` worktrees). `git ls-remote` still reports remote main at the original ticket 02 baseline `0096a50ee7a2318c14d3c8c46b109aa3165f49a1`. Thus 01 is integrated locally, not remotely. Preserve local main with `backup/pre-ticket-02-integration-442b4fc`, commit the explicit ticket 02 file set, integrate local main into the ticket worktree, regenerate the combined release manifest and verify there, then fast-forward local main only. Resulting commits and combined verification are reported in the session handoff; this note does not claim completion or remote integration.
