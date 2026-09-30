# 04 — AI-038 — Apply immutable Action pinning consistently

**Status:** ready-for-agent
**Milestone:** 6 — Known Gap Closure
**Blocked by:** None — can start immediately.
**PRD requirements:** [PRD.md](../../../PRD.md) §10.

**What to build:** CI and release workflows use the same immutable pinning policy for every external GitHub Actions dependency without changing what their jobs do.

## Scope and implementation boundaries

Correct mutable external Action references in place. Reuse already-verified pins where the intended Action version is the same; otherwise verify the commit against the Action's authoritative upstream source. Keep readable version comments. A local action path is not an external version reference.

PRD.md remains the sole specification; §4–5 and §42 apply. Do not upgrade unrelated Actions, redesign workflows, add permissions, or broaden the platform matrix as part of pinning. Obtain the required approval before editing CI configuration. Do not add a generic dependency-management framework.

## Acceptance criteria

- [x] Every external GitHub Actions dependency in CI and release is pinned to a full immutable commit SHA, not a mutable tag or branch.
- [x] Each version comment corresponds to the pinned upstream commit; verification sources or reused verified pin evidence are recorded with completion evidence.
- [x] CI and release use the same policy, with no overlooked job or workflow reference.
- [x] Jobs retain their existing commands, triggers, permissions, and operating-system coverage except for the pin syntax itself.
- [x] A focused repository check rejects a mutable external Action reference and accepts the conforming workflows, using existing test conventions rather than a new framework.

## Verification

Inventory all external workflow references, verify the pins, run the focused pinning check and `npm test`, and inspect the diff for accidental behavioral or permission changes. Perform a supply-chain/security review of the changed references. Distinguish local workflow checks from actual CI execution; do not claim cross-platform runs occurred unless their job evidence exists.

## Comments

### 2026-09-30 — Ticket 04 isolated implementation

#### Baseline and scope

- `BASE_SHA`: `fde0879d443c5bcf1fb1c6702260b1446222d0a7`. The initial fetch found remote main at `0c7f63d9f2668d2affdfa11f27a36a1af101fdb5`, which did not contain ticket 03, so implementation stopped without edits. After the user requested continuation, a fresh `git fetch origin main` and `git ls-remote origin refs/heads/main` both resolved to this `BASE_SHA`; `git merge-base --is-ancestor fde0879d443c5bcf1fb1c6702260b1446222d0a7 origin/main` succeeded.
- Branch: `implement/v0.1.3-ticket-04`; worktree: `.claude/worktrees/v0.1.3-ticket-04`, created directly from the exact verified SHA. Existing worktrees were preserved; no uncommitted content was copied from them.
- Direct dependencies: none; `Blocked by` is unchanged. The additional ticket 03 retention check found dynamic package name/version, actual packed filename output/consumers, and failure assertions in the verified baseline. Its historical Comments were consulted, not substituted for this ticket's fresh checks.
- The user explicitly authorized the necessary local CI/release immutable-pinning edits. Six CI tag references now reuse the release pins after fresh upstream verification; the release SHAs themselves are unchanged. All eight references use precise version comments. Commands, triggers, permissions, OS/Node matrices, OIDC and publishing policy remain unchanged. No dependency, framework, package metadata, PRD, other ticket or user-environment configuration changed.

#### Complete reference inventory and upstream evidence

| Workflow / jobs | References | Verified upstream commit / comment |
|---|---:|---|
| `.github/workflows/ci.yml` — `posix-test`, `windows-smoke`, `package` | 3 checkout + 3 setup-node | Same two verified pins below |
| `.github/workflows/release.yml` — `publish` | 1 checkout + 1 setup-node | Existing SHAs retained; comments made precise |

- Checkout: `3d3c42e5aac5ba805825da76410c181273ba90b1` / `# v7.0.1`. Read-only `gh api` calls to official [v7 ref](https://api.github.com/repos/actions/checkout/git/ref/tags/v7), [v7.0.1 ref](https://api.github.com/repos/actions/checkout/git/ref/tags/v7.0.1), [commit](https://github.com/actions/checkout/commit/3d3c42e5aac5ba805825da76410c181273ba90b1), tags list and [release](https://github.com/actions/checkout/releases/tag/v7.0.1) verified both tags point directly to this commit.
- Setup Node: `820762786026740c76f36085b0efc47a31fe5020` / `# v7.0.0`. The same official-upstream verification used [v7 ref](https://api.github.com/repos/actions/setup-node/git/ref/tags/v7), [v7.0.0 ref](https://api.github.com/repos/actions/setup-node/git/ref/tags/v7.0.0), [commit](https://github.com/actions/setup-node/commit/820762786026740c76f36085b0efc47a31fe5020), tags list and [release](https://github.com/actions/setup-node/releases/tag/v7.0.0).
- Reuse location: `BASE_SHA:.github/workflows/release.yml`, lines 23–24. The existing SHA was only a candidate until official upstream tag/commit correspondence was checked. At verification time the CI's `v7` tags resolved to those same commits, so this is pinning, not an Action upgrade.
- `git ls-files .github/workflows` identified only `ci.yml` and `release.yml`; inventory found eight external references across all four jobs and no local Action, container Action or reusable-workflow reference in the real workflows. The repository check discovers every `.yml`/`.yaml` in that directory instead of hardcoding the two current filenames.

#### Implementation and targeted evidence

- `tests/installation/action-pinning.test.js` uses the existing ESM `node:test` / strict-assert convention and Node standard library only. Real workflow files are read-only inputs. Isolated in-memory fixtures cover full pins, mutable tags/branches, short/missing refs, quotes, subdirectory Actions, job-level reusable workflows, later jobs, local paths, flow mappings and block-scalar scripts.
- TDD: the first repository check failed at `ci.yml:20` against `actions/checkout@v7`; replacing the verified pins made it pass. An isolated mutable flow-mapping fixture then reproduced a missing rejection; the check was extended and that regression passed without changing real workflows for fault injection.
- Targeted `node --check tests/installation/action-pinning.test.js` passed. `node --test tests/installation/action-pinning.test.js tests/installation/release-workflow.test.js`: **47 passed, 0 failed, 0 skipped**, with disposable HOME/npm configuration/cache and temporary directories beneath this worktree. The SSOT tests use local publish/registry doubles, not real publication or registry execution.

#### Review and corrections

- `/code-review` was invoked with the fixed `BASE_SHA`, current ticket/Comments and PRD scope. Its default committed three-dot diff was empty; the actual Standards/Spec reviews used `git diff BASE_SHA --` for all tracked staged/unstaged changes, `git ls-files --others --exclude-standard`, and explicit reading of the new test. No commit was created to manufacture review input.
- Standards found no documented-standard violations or material smells. Functional findings: an inline comment containing `: |` could hide mutable Actions; quoted/plain script text could be misidentified as flow dependencies. Spec additionally reproduced a folded/literal step-name scalar-boundary bypass. Five isolated regression cases failed before correction, then passed after unquoted-comment handling, quoted-scalar-aware flow matching and mapping-key indentation were corrected.
- Standards re-review found one directly introduced gap for a comma-led multiline flow continuation. Its isolated regression failed before correction; quote-safe cross-line flow context and line-start flow-key recognition fixed it. Positive continued pinned/local mappings and flow-context reset remain covered. Final focused check: **28 passed, 0 failed, 0 skipped**. Final narrow Standards and Spec re-reviews confirmed this last correction and all prior findings resolved, with no directly introduced issue found. Spec independently checked continued tag/branch rejection, quoted keys, pinned/local acceptance, quote-safe depth and context reset using in-memory probes. No unresolved review finding remains.
- `/security-review` was invoked; the supplied default commit diff was empty, so its read-only supply-chain assessment explicitly covered the real tracked changes plus the new test. It found **no high-confidence new HIGH/MEDIUM vulnerability**. It confirmed official-upstream correspondence, no unintended Action upgrade, unchanged release SHAs and preservation of permissions, OIDC and ticket 03 filename/output/verification safeguards. The reported scalar-text checker observation was addressed as a functional finding, not mislabeled as a vulnerability.

#### Final validation

- Final local environment: Darwin, Node `v25.9.0`, npm `11.17.0`. All temporary HOME/npm configuration/cache/fixture roots were beneath this worktree and cleaned up; no dependency or user-environment installation/configuration was performed.
- After the last checker correction, `node --test tests/installation/action-pinning.test.js tests/installation/release-workflow.test.js`: **54 passed, 0 failed, 0 skipped**. This includes the retained dynamic name/version, non-conventional packed filename propagation and metadata/file/digest/filename failure regressions from ticket 03.
- Final `npm test` after that correction: **328 tests, 326 passed, 0 failed, 2 skipped**. The two existing skips are Windows Native CLI lifecycle and Windows Native symlink-EPERM fallback; they are not new skipped tests and this Darwin run is not Windows-native acceptance. An earlier full-suite run preceded the continuation correction and is not used as final evidence.
- Final CI JavaScript syntax command (`find bin src scripts tests -type f -name '*.js' -print0 | xargs -0 -n1 node --check`) passed. No typecheck script/toolchain exists; none was added.
- Final local workflow validation parsed both YAML files using the existing Ruby YAML library, verified all eight SHA references, **15 `bash -n` script checks**, **5 Node heredoc syntax checks**, unique step IDs and existing preceding output-source IDs. Parsed workflow structures normalized only for the two known Action pin values matched `BASE_SHA` exactly; command bodies, triggers, permissions, OS/Node coverage and publishing semantics are unchanged. These are local structural/syntax checks, not execution of entire CI jobs.
- Inspected `scripts/release-manifest.js` output/cleanup paths before running it in a disposable package copy. `node scripts/release-manifest.js`, then `node scripts/release-manifest.js --check`, passed: **23 entries**, tree digest `sha256:cc11f062f3aa557d1f03441014c8fd966cc17e99c891d817f6597ba9f8f1b031`. Regenerated manifest was byte-identical to the baseline. Workflow/test/ticket changes are outside the npm package allowlist; no `release-manifest.json` update is needed.
- Isolated `npm pack --dry-run --ignore-scripts --json` passed for `@apparux/agent-init@0.1.3-rc.2`, actual filename `apparux-agent-init-0.1.3-rc.2.tgz`, **23 entries**, with file paths/modes equal to the manifest. No actual package publication or real registry verification occurred.

#### Limits and handoff

- All five acceptance criteria are checked based on fresh local checks and official-upstream evidence. Remote GitHub Actions CI, Ubuntu/macOS runner jobs, Windows-native jobs, Node 18/22/24 matrix execution and release/publication were **not run**. `actionlint` is unavailable and was not run. No complete release qualification is claimed.
- Only CI/release, this ticket's checkboxes/Comments and the new focused test are changed. Status and `Blocked by` are unchanged; PRD and other tickets are untouched. The final ticket-record supplement was reviewed against tracker/scope rules and the actual test/review results. Final Git scope and whitespace checks passed: only these four delivery files differ from the fixed baseline, the staging area is empty and no temporary pack/test outputs remain. The original worktree retains its pre-existing untracked `.claude/` assets and has no tracked or staged changes. No implementation input changed after the final 54-test focused run and 328-test suite; subsequent edits only completed this ticket's evidence record.
- Commit, push, merge, PR creation, remote workflow execution and publication remain unauthorized and were not performed. Keep this worktree and its uncommitted changes for a separately authorized integration session; do not start another ticket.
- Shared-file risk: `.github/workflows/release.yml` overlaps ticket 03, but this ticket changes only the two Action version comments there. Integrate serially, preserve 03's SSOT/filename/failure safeguards and this ticket's CI pins, and revalidate combined workflows/tests. If integration changes packed payload inputs, regenerate/check the manifest from final combined content rather than hand-merging a digest.
