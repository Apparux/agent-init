# 03 — AI-037 — Use one release version source end to end

**Status:** ready-for-agent
**Milestone:** 6 — Known Gap Closure
**Blocked by:** None — can start immediately.
**PRD requirements:** [PRD.md](../../../PRD.md) §9; AC-S01, AC-S02.

**What to build:** A version change in package metadata flows through CLI reporting, packing, artifact selection, and registry verification without editing independent workflow version constants.

## Scope and implementation boundaries

The existing CLI already reads package metadata. Preserve that behavior and correct duplicated release-workflow values. Read package name/version dynamically and use the filename and metadata returned by `npm pack --json`; do not reconstruct a versioned tarball name. Reuse the existing artifact/digest verification approach and Node standard library. Do not create a general release framework or add a second version registry.

PRD.md remains the sole specification; §4–5 and §42 apply. Workflow edits require the repository's configuration-change approval. This ticket does not authorize publishing, registry mutation, credential access, or a version bump unrelated to validating the SSOT change.

## Acceptance criteria

- [x] No independent release-version constant remains in workflow naming, expected metadata, tarball selection, artifact paths, publish inputs, or registry verification.
- [x] In an isolated package copy, changing only package version causes the release verification inputs and packed artifact expectations to use that version (AC-S01).
- [x] CLI output, package metadata, tarball metadata, and registry-verification requests derive from the same package version (AC-S02).
- [x] The actual packed filename is propagated to downstream steps rather than guessed from package naming conventions.
- [x] Existing mismatched version, file list, and digest checks still fail; removing hardcoded constants does not weaken verification.
- [x] Tests establish the dynamic behavior without publishing any package.

## Verification

Add focused regression coverage using temporary metadata/package copies and recorded registry-verification inputs or local test doubles. Run CLI/package tests, `npm test`, and `npm pack --dry-run`; inspect the workflow's dynamic value propagation. Any actual pack output used in testing must live in a disposable location. Record workflow validation performed and any remote checks not run.

## Comments

### 2026-09-22 — Merged baseline: `bdf2999`

- Already present: `.github/workflows/release.yml` derives version from package metadata; `scripts/release-manifest.js` and `release-manifest.json` provide package shape/digest verification.
- Remaining: the release workflow still constructs the tarball filename. Propagate the actual `npm pack --json` filename through extraction, verification, and publication. `tests/installation/tarball.test.js` still contains a fixed version; add isolated version-change coverage and retain negative metadata/file/digest checks. Existing code is a starting point, not full AC-S01/AC-S02 evidence.

### 2026-09-30 — Ticket 03 local implementation and handoff

#### Baseline and scope

- `BASE_SHA`: `0c7f63d9f2668d2affdfa11f27a36a1af101fdb5`. Refreshed with `git fetch origin main` and verified that `git ls-remote origin refs/heads/main` matched `origin/main` before creating the worktree. Did not revert to the older Comments baseline.
- Branch: `implement/v0.1.3-ticket-03`; worktree: `.claude/worktrees/v0.1.3-ticket-03`. All implementation, testing and review used this worktree or disposable fixtures created from it. Existing 01/02 worktrees were preserved; no uncommitted content was copied from another worktree.
- Direct dependencies: none. The additional 01/02 integration check confirmed both implementation commits (`442b4fcdf441263dd582d3b145b3a36502b85084`, `953fceb425807718352996ccd852050af7abe1a6`) are direct parents of `BASE_SHA`, with their implementation/tests and prior joint verification record present. That historical record was not substituted for this ticket's tests.
- The user explicitly authorized necessary local `release.yml` SSOT edits. Workflow permissions, OIDC, Action references, npm version, publish tag, retry policy and approved package/repository/access guards remain unchanged. No formal package version bump, dependency or user-environment changes were made.

#### Implementation and acceptance evidence

- `.github/workflows/release.yml`: package metadata now supplies both name and version. The `pack` step reads the actual filename from `npm pack --json`, validates it, extracts with an argument array, and exports it only after successful extraction. Artifact verification and quoted publish input consume that output; registry verification consumes the same derived name/version. No tarball naming convention is reconstructed.
- `tests/cli/commands.test.js` and `tests/installation/tarball.test.js`: version expectations now use package metadata; the tarball test also compares packed name/version with it. Existing CLI implementation is unchanged.
- `tests/installation/release-workflow.test.js`: executes the actual named workflow scripts with their declared output/env wiring. Disposable copies cover the current version and a version-only change to `9.8.7-ssot.1`, source/packed CLI output, pack metadata, publish arguments and recorded registry requests. A renamed package verifies dynamic name propagation while the approved release identity guard still rejects it.
- Real npm packing is local, offline and uses `--ignore-scripts`, isolated HOME/config/cache and disposable output paths. At the workflow boundary, an npm double returns a real tarball under the non-conventional filename `release candidate.tgz` and records publish arguments without invoking real publication. A preloaded fetch double records registry URLs and returns local metadata/tarball bytes, with no fallback to network requests. These are local workflow/input checks, not remote CI or registry evidence.
- Negative coverage still requires failure for artifact name/version/filename/entry count, file list/mode, packed version, tree digest, invalid shasum/integrity, registry version/latest/digest and downloaded tarball digest mismatches. Invalid path/CR-LF filenames fail before workflow outputs are written.
- TDD evidence: the original extraction failed by looking for the guessed filename; after extraction was corrected, downstream verification failed against the guessed filename. Both regressions became green after actual filename propagation. The review-discovered unquoted preload path was separately reproduced as `MODULE_NOT_FOUND` with a spaced fixture path, then fixed with a quoted `NODE_OPTIONS` value; fixtures retain spaces permanently.

#### Final verification and review

- `node --test tests/cli/commands.test.js tests/installation/tarball.test.js tests/installation/release-workflow.test.js`: **31 passed, 0 failed, 0 skipped**, rerun after the review fix.
- `node --check` for those three files: passed. No typecheck script/toolchain exists; none was introduced.
- Final `npm test`, after the review fix, with disposable HOME/npm configuration: **300 tests, 298 passed, 0 failed, 2 skipped**. The skips are the existing Windows-native lifecycle and symlink-EPERM tests; this Darwin run is not Windows-native validation.
- Local workflow validation: parsed YAML using the existing Ruby YAML library; checked **9 shell scripts** with `bash -n`, **5 Node heredocs** with `node --check`, unique step IDs and output references to existing IDs. Named workflow script execution is also covered by the focused tests. `actionlint` is unavailable and was not run; no claim of full GitHub Actions validation is made.
- Final `npm pack --dry-run --ignore-scripts --json` in a disposable package copy: passed; current metadata remains `@apparux/agent-init@0.1.3-rc.2`, actual filename `apparux-agent-init-0.1.3-rc.2.tgz`, **23 entries**, file paths/modes equal to the checked-in manifest.
- Inspected the manifest script's output/cleanup paths before execution. Final `node scripts/release-manifest.js` and `node scripts/release-manifest.js --check` ran in a disposable copy; the regenerated manifest is byte-identical: **23 entries**, tree digest `sha256:cc11f062f3aa557d1f03441014c8fd966cc17e99c891d817f6597ba9f8f1b031`. No packed payload files changed, so no derived `release-manifest.json` update is needed.
- `/code-review` used fixed `BASE_SHA`, `git diff BASE_SHA --` for every tracked working-tree change, plus `git ls-files --others --exclude-standard` and explicit review of the new test; it did not rely on an empty three-dot diff. Standards found one preload-path quoting issue, now fixed, regression-tested and re-reviewed as resolved. Spec found no implementation defects or scope creep; the fix was also re-reviewed. No unresolved findings remain. Filename/path/output and publish-input safety were included in review.
- The final ticket-record supplement was reviewed against tracker conventions and ticket scope: only this ticket's acceptance checkboxes and Comments changed; its Status and other tickets are unchanged. Final `git diff --check` and worktree-state checks passed, with only the four implementation/test files and this ticket modified or added and no leftover packing outputs.

#### Limits and integration conditions

- All six ticket acceptance items are checked on the basis of local behavior/input verification. Remote GitHub Actions CI, real registry verification, publication and Windows-native execution were **not run**; this ticket does not claim full release qualification.
- Implementation is locally complete, with no unresolved ticket blocker. Commit, push, merge, PR creation and publication remain unauthorized and were not performed. Worktree and all changes remain uncommitted for an explicitly authorized integration session.
- Shared-file risk: ticket 04 may also edit `.github/workflows/release.yml`; integrate serially, preserving its Action-pinning work separately from this ticket's SSOT changes. Reverify the combined workflow and tests, and regenerate/check the manifest from final combined payload content if integration changes packing. Do not hand-merge tree digests or start the next ticket automatically.

### 2026-09-30 — Authorized local main integration and combined verification

- Subsequent user authorization permits local integration and verification, superseding the earlier no-commit/no-merge handoff state. Push, remote workflow execution, publication and registry mutation remain outside this authorization.
- Refetched and checked `origin/main` before integration: both remote and local main were still `0c7f63d9f2668d2affdfa11f27a36a1af101fdb5`. Main had no tracked or staged changes; pre-existing untracked/ignored assets and the 01/02 worktrees were preserved.
- Created the local backup reference `backup/v0.1.3-ticket-03-main-20260930` at the pre-integration main SHA. Committed exactly this ticket's five reviewed files on `implement/v0.1.3-ticket-03` as `985e67eaaa3889c6b4f86ff7aaacb8b7d27612e9` (`fix: propagate actual packed filename through release workflow`).
- Local main was integrated with `git merge --ff-only 985e67eaaa3889c6b4f86ff7aaacb8b7d27612e9`: no conflicts, no conflict-resolution code changes, and its committed tree matched the ticket branch exactly. Existing Standards/Spec review conclusions apply to that unchanged implementation; this integration record received a supplemental tracker/scope review.
- Combined validation used a `git archive` of the exact integrated main SHA in a disposable repository, isolated HOME, empty npm config files, offline npm cache/settings and disposable pack paths. It included the previously integrated 01/02 implementation, not just this ticket's worktree or uncommitted copies.
- Integration-runner note: the first archive attempt could not spawn PATH-resolved Git from ARM64 Node (`Unknown system error -86`; the PATH Git binary was Intel-only), so tests did not start in that attempt. Using the already-working shell Git generated the same SHA snapshot successfully. No package/tool installation, environment reconfiguration or code workaround was introduced.
- On that integrated snapshot, the three changed test files passed `node --check`; local YAML parsing, **9 `bash -n` checks**, **5 Node heredoc syntax checks**, unique step IDs and output references passed. Remote GitHub Actions execution and `actionlint` were not run.
- Combined focused command `node --test tests/cli/commands.test.js tests/installation/tarball.test.js tests/installation/release-workflow.test.js`: **31 passed, 0 failed, 0 skipped**.
- Combined full `npm test`: **300 tests, 298 passed, 0 failed, 2 Windows-native skips**. This is fresh evidence for the integrated main implementation; Darwin execution still does not establish Windows-native acceptance.
- Combined `node scripts/release-manifest.js`, followed by `node scripts/release-manifest.js --check`, passed in the disposable snapshot; the regenerated manifest was byte-identical, **23 entries**, tree digest `sha256:cc11f062f3aa557d1f03441014c8fd966cc17e99c891d817f6597ba9f8f1b031`. Combined `npm pack --dry-run --ignore-scripts --json` passed with current package metadata/version and exactly the pinned paths/modes. No release-manifest update or formal version bump was required.
- The final evidence-record commit only appends this Comments section; executable, workflow, tests and packed payload inputs remain identical to the validated implementation commit. Final integration checks must confirm that scope and identical main/ticket trees. No real publication, registry checks or remote CI were performed, and the next ticket was not started.
