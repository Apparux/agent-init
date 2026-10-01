# 06 — AI-040 — Evaluate versioned trigger cases through acceptance artifacts

**Status:** ready-for-agent
**Milestone:** 7 — Real Trigger Qualification
**Blocked by:** AI-035 — Routing metadata; AI-036 — Parent rollback; AI-037 — Version SSOT; AI-038 — Action pinning; AI-039 — Document status.
**Dependency rationale:** All Milestone 6 work must finish before Milestone 7 starts, as required by PRD §41; metadata is also a direct input to trigger evaluation.
**PRD requirements:** [PRD.md](../../../PRD.md) §13–15, §19.

**What to build:** A version-controlled trigger case and a recorded acceptance artifact can be evaluated together to produce a reproducible expected-versus-observed result. Corpus and artifact structure are delivered with a working consumer, not as disconnected schemas.

## Scope and implementation boundaries

Use existing fixture IDs, generated-Skill conventions, digest utilities, evaluator patterns, and Node standard library. Keep shared preparation/digest/result logic small enough for the two concrete Harness runners to reuse. Do not introduce a generic Agent framework, statistical framework, or new project Apply API.

PRD.md remains the sole specification; §4–5 and §42 apply. Synthetic artifacts are test inputs only, not real external acceptance. Keep credentials, private HOME contents, and unrelated conversation data out of committed corpus and artifacts.

## Acceptance criteria

- [x] Each generated Skill selected for real acceptance has positive, negative, near-miss, and collision prompts, with stable case/fixture identity and explicit mustLoad/mustNotLoad expectations.
- [x] Cases identify their category so later aggregation does not infer it from prompt wording; contradictory or unknown expectations are rejected.
- [x] Corpus data is tracked in the repository and uses the existing behavior fixtures rather than invented technology coverage.
- [x] The artifact validator requires schemaVersion, supported harness, harnessVersion, fixtureId, caseId, expected, observed.loaded, result, recordedAt, and mother/generated Skill, fixture, and trigger-corpus digests.
- [x] For multi-Skill cases, the generated payload digest binds the relevant generated Skill set deterministically, so changing any contributing Skill changes the digest.
- [x] The evaluator checks the authoritative corpus expectations against observed selection; forged expected values, mismatched case/fixture identity, and a claimed pass inconsistent with observations fail.
- [x] Missing or unparseable selection evidence cannot be treated as a genuine empty loaded list; a valid observed empty list remains valid for an appropriate negative case.
- [x] One conforming artifact passes and isolated schema, identity, expectation, and result mutations fail for the intended reason.

## Verification

Test the complete case-to-artifact-to-result path with existing fixture builders and explicit synthetic test inputs. Run focused corpus/artifact tests and `npm test`. No live Harness claim is made here; AI-041 and AI-042 supply real observations, and AI-047 enforces comparison with the current payload.

## Comments

### 2026-09-22 — Merged baseline: `bdf2999`

- Boundary: `src/installation/harnesses.js` now lists six install targets and supports custom configuration. Its static verification labels describe registry entries, not current-payload live routing evidence.
- Keep this ticket's two concrete acceptance runners scoped to Claude and Codex (AI-041/042). Installation/discovery tests do not replace the corpus-to-observed-selection artifact contract or authorize expanding live qualification to every registry entry.

### 2026-09-30 — Verified repaired dependency baseline; implementation pending

- Initial dependency verification stopped at `8fd2fa05cfb0b044a7ec23a39edfdda1f10c0eee`: ticket 04's repository check rejected conforming workflow references on Windows. No ticket 06 branch/worktree or implementation was created to bypass that gate.
- The user separately authorized the local ticket 04 CRLF repair, its two-file commit/local integration, and then confirmed the exact non-force push. Repair commit `f8e110d759750ae7e5f5c566b9f45a99fd597adc` is now synchronized to main. These authorizations do not permit committing, merging or pushing ticket 06, rerunning/dispatching workflows or publishing.
- A fresh successful `git fetch origin` and `git ls-remote` verified the source `https://github.com/Apparux/agent-init.git` and identical local main, `origin/main` and remote main at `BASE_SHA` **`f8e110d759750ae7e5f5c566b9f45a99fd597adc`**. Branch `implement/v0.1.3-ticket-06` and worktree `.claude/worktrees/v0.1.3-ticket-06` were created directly from that exact SHA with empty tracked/staged changes. All existing worktrees were retained; no uncommitted contents were copied from them.

| Direct dependency | Baseline implementation / applicable evidence | Conclusion |
|---|---|---|
| 01 / AI-035 | `442b4fc` is an ancestor; generated metadata, candidate/approval binding and mutation assertions are present. Their inputs are unchanged from the previously verified baseline, and current Ubuntu/macOS full-suite jobs pass. | Deterministic routing-contract criteria satisfied; no live routing claim. |
| 02 / AI-036 | `953fceb` is an ancestor; durable parent creation records, recovery and owned child-first cleanup are present. Its 28 tests passed on all three platforms in the prior verified run; inputs remain unchanged, current POSIX jobs pass, and none of the current Windows failures belongs to this test file. | Exercised parent-rollback criteria satisfied, not full Windows lifecycle qualification. |
| 03 / AI-037 | `985e67e` is an ancestor; dynamic package name/version and actual packed-filename propagation plus failure assertions remain unchanged. Current POSIX/Package jobs pass. | SSOT dependency satisfied; no real publication claim. |
| 04 / AI-038 | `a5be9a8` plus repair `f8e110d` are ancestors. Both real-workflow repository checks and all new CRLF rejection/bypass regressions actually pass on Windows in the current run. | Conforming-workflow acceptance gap repaired and synchronized. |
| 05 / AI-039 | `670ea69` and its integration are ancestors; DESIGN/TASKS distinguish historical implementation, merged capabilities and pending qualification. These documentation inputs are unchanged, and PRD remains the sole specification. | Document-state dependency satisfied; qualification is not declared complete. |

- Current automatic [CI run 36797285294](https://github.com/Apparux/agent-init/actions/runs/36797285294), exact `BASE_SHA`, is **failure**, not a passing run. Ubuntu/macOS/Package jobs succeed with **332 tests, 330 passed, 0 failed, 2 skipped** each. Windows reports **171 tests, 153 passed, 10 failed, 8 skipped**; its repository pinning tests and CRLF regressions pass. The run was caused by the separately confirmed push, not a rerun/dispatch.
- Remaining Windows failures are the five install/update/uninstall characterization path assertions, executable-bit digest assertion, mutable-alias readlink assertion, same-destination symlink replacement `EPERM`, packed distribution lifecycle and replaced-target permissions assertion. They are not recorded as passing. They do not invalidate the passing dependency-specific routing, rollback, SSOT or checker evidence; the digest-mode failure specifically limits cross-platform permission-equivalence claims, not content-change binding. No unrelated Windows fix is included in ticket 06.
- Actual remote evidence was read using `gh`; a job-log request returned a transport EOF, so the completed-run log archive was read instead. No local/remote test result was fabricated and no new workflow was triggered for diagnosis.
- Implementation, ticket 06 TDD/validation and review are pending at this record stage. Synthetic artifacts will be test inputs only; no true triggering, threshold pass, publication or complete qualification is claimed.

### 2026-09-30 — Local implementation validated; Git tracking/integration pending

- Baseline remains **`f8e110d759750ae7e5f5c566b9f45a99fd597adc`**, branch `implement/v0.1.3-ticket-06`, worktree `.claude/worktrees/v0.1.3-ticket-06`. No ticket 06 commit, staging, merge, push, PR, workflow dispatch/rerun or publication was performed. The preceding dependency/CI evidence and its limitations remain applicable; the current baseline CI is still recorded as failure.
- Delivery: `tests/trigger-corpus/cases.json` contains **21 authored cases**: the four explicit categories for each of five selected existing generated variants (`03-node-pnpm:build-verify`, `11-maven-multi-module-build-verify:build-verify`, `12-flyway-database-migration:database-migration`, `13-audit-log:audit-log`, `15-deployment:deployment`), plus a `14-redis-no-skill` negative case. Stable IDs, primary fixture, source map and `mustLoad`/`mustNotLoad` are explicit. Positive coverage counts a Skill only when that case actually requires it.
- Collision cases explicitly identify two source fixtures through `skillFixtures` and multi-repository prompts. This does not change any existing fixture manifest or assert that a single-Skill fixture generates two Skills. Preparation binds every contributing fixture and exactly the declared generated Skill payload set, ordered by canonical identity. Each contributing payload was mutated and restored independently; both change the generated-set digest, and changing a non-primary fixture changes the fixture-set digest.
- Working consumer: `tests/agent-init/trigger-evaluation.js` exports corpus loading, preparation, artifact creation and evaluation. It reuses `validateFixtureManifest`, `digestProposal`, `digestTree` and `readRegularFileNoFollow`. Test materialization uses real existing fixture metadata and `copyTree`; private builders inside existing `.test.js` files were not imported or represented as reused APIs. No generic Agent/statistical framework or project Apply API was introduced.
- The consumer validates the required artifact fields, supports only `claude-code` and `codex`, checks case/fixture identity and authoritative expectations, recomputes selection results, and compares all four artifact digests with the supplied current local inputs. Tree digests bind mother/generated payload bytes, structure and executable status; fixture/Skill sets use deterministic aggregates, and the corpus digest binds raw JSON bytes. These are per-case integrity checks, not AI-047's complete current-payload/live qualification gate.
- Missing, malformed, duplicate or unknown selection evidence produces contextual `SELECTION_EVIDENCE` rejection rather than a fallback empty list. Explicit empty lists work for negative cases, including Redis SKIP, and fail a positive case honestly. Artifact creation retains only loaded Skill names, not unrelated conversation data. No credentials or real HOME contents were added to corpus or artifacts. No harness/model, migration, deployment or publication command was executed for these synthetic observations.
- TDD at the agreed public case → artifact → result seam: the initial absent-module failure was followed by real schema, identity, expected-value, claimed-result and corpus mutation failures; each guard was added only after its failing slice. Reversed multi-Skill input order initially changed the digest and was fixed by canonical ordering. Four forged/changed input-digest slices failed before digest-value comparison (**9 failed**); missing/extra contributors and physical identity slices failed before guards (**9 failed**); explicit evidence slices failed before parsing/validation (**13 failed**); a forbidden Skill was initially miscounted as positive coverage and now fails with `CORPUS_COVERAGE`. The retained mutation tests require their intended error codes, not arbitrary failure.

| Local verification on the final implementation | Actual result |
|---|---|
| `node --test tests/agent-init/trigger-evaluation.test.js` | **115 passed, 0 failed/skipped**; all 21 cases round-trip recorded JSON artifacts for both supported harness identifiers using independent literal synthetic selections. |
| `node --test tests/agent-init/evaluation-harness.test.js tests/agent-init/fixture-matrix.test.js tests/agent-init/trigger-evaluation.test.js` | **220 passed, 0 failed/skipped**, with owned isolated HOME/npm/temp paths. |
| `node --check` over all JavaScript files in `bin`, `src`, `scripts`, `tests` | **50 files passed**; no typecheck toolchain exists or was added. |
| Final `npm test`, after both review axes completed | **447 tests, 445 passed, 0 failed, 2 skipped**; the skips are the existing Windows Native CLI lifecycle and EPERM fallback tests on macOS. Owned HOME/USERPROFILE, npm configuration/cache and temporary paths were isolated beneath this worktree and cleaned. npm was offline; no dependency was installed. |
| Offline isolated `npm pack --dry-run --json --ignore-scripts --offline` | **23 package files**; tests, corpus, tickets and temporary/worktree directories are excluded. Packed payload and release manifest are unchanged, so regeneration is not applicable. |

- `/code-review` used fixed `BASE_SHA`, `git diff BASE_SHA --`, the empty commit list, and an explicit read of all three new/untracked files; it did not rely on the empty three-dot diff. **Standards:** 0 documented violations and 0 material smells. Supplemental path/identity/privacy review found no newly introduced security defect; leaf no-follow/tree checks do not guarantee ancestor-path no-follow, atomic snapshots or concurrent-replacement protection. **Spec:** 0 reproduced implementation defects and 0 scope-creep findings; 1 pending delivery criterion (Git tracking). Independent public-interface recorded-JSON verification matched **672/672** observation combinations, rejected **672/672** opposite-result claims and **630/630** forged expectations. No code changes were required by these reviews before the final full suite.
- **Acceptance accounting:** seven behavioral criteria are verified and checked. The Git-tracking criterion remains unchecked: all three new files, including corpus, are still **untracked**. Authored repository-path corpus delivery is not claimed as already committed/version-controlled. Triage status is unchanged; it is not a completion flag. No staging or commit was silently performed to turn that criterion green.
- **Handoff:** implementation and local deterministic verification are complete; all ticket acceptance is not yet complete because Git tracking remains pending. The changes are ready for separately authorized local integration review, not already integrated. A later authorized integration must include all three new files and this ticket, validate against then-current main, and perform its required combined tests/remote verification. Subsequent tickets cannot treat this uncommitted worktree as an origin/main dependency. No next ticket was started.
- PRD, existing fixture manifests, other tickets, package metadata/dependencies, CI, scripts, packed payload and release manifest remain unchanged relative to `BASE_SHA`. The original main workspace has no tracked/staged changes from ticket 06; its existing untracked `.claude/` is retained. No leftover validation sandbox is intended to remain.
- No live triggering, threshold pass, Windows-native qualification, publication or complete qualification is claimed. Remote dependency evidence above was actually read via `git`/`gh`; this implementation/review used local context only, with no Web search/search Skill or additional remote workflow operation.

### 2026-09-30 — Separately authorized Git tracking and local integration

- The user subsequently authorized committing ticket 06, integrating it into local main, validating the integrated result and pushing, then providing ticket 07/08 prompts. This supersedes the preceding no-commit handoff for ticket 06 only; it does not authorize starting 07/08, publishing or dispatching/rerunning workflows. The global second-confirmation gate still applies before the actual remote push.
- A fresh successful `git fetch origin` and `git ls-remote origin refs/heads/main` again verified origin `https://github.com/Apparux/agent-init.git` and synchronized local/remote main at **`f8e110d759750ae7e5f5c566b9f45a99fd597adc`**. The original workspace had no tracked/staged changes; its existing untracked `.claude/` was retained. Backup branch `backup/v0.1.3-ticket-06-main-20260930` now preserves that exact pre-integration main.
- The three new delivery files were explicitly added to Git. `git ls-files --error-unmatch` succeeds for the corpus, consumer and tests; the corpus version-control criterion is now verified and checked. All **8/8 ticket-06 criteria** are locally satisfied, without converting synthetic observations into live acceptance. No consumer/test/corpus code changed after the recorded reviews and final 447-test validation.
- The authorized commit is limited to these three files and this ticket. Local integration will use fast-forward-only after exact scope and baseline checks; it will not overwrite another worktree, force a branch or merge unrelated changes. The final integrated suite and remote outcome must be reported from actual results, not assumed from the earlier worktree validation. The npm publishing workflow is manual-only and will not be dispatched.
