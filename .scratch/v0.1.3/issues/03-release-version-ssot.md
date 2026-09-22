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

- [ ] No independent release-version constant remains in workflow naming, expected metadata, tarball selection, artifact paths, publish inputs, or registry verification.
- [ ] In an isolated package copy, changing only package version causes the release verification inputs and packed artifact expectations to use that version (AC-S01).
- [ ] CLI output, package metadata, tarball metadata, and registry-verification requests derive from the same package version (AC-S02).
- [ ] The actual packed filename is propagated to downstream steps rather than guessed from package naming conventions.
- [ ] Existing mismatched version, file list, and digest checks still fail; removing hardcoded constants does not weaken verification.
- [ ] Tests establish the dynamic behavior without publishing any package.

## Verification

Add focused regression coverage using temporary metadata/package copies and recorded registry-verification inputs or local test doubles. Run CLI/package tests, `npm test`, and `npm pack --dry-run`; inspect the workflow's dynamic value propagation. Any actual pack output used in testing must live in a disposable location. Record workflow validation performed and any remote checks not run.

## Comments

### 2026-09-22 — Merged baseline: `bdf2999`

- Already present: `.github/workflows/release.yml` derives version from package metadata; `scripts/release-manifest.js` and `release-manifest.json` provide package shape/digest verification.
- Remaining: the release workflow still constructs the tarball filename. Propagate the actual `npm pack --json` filename through extraction, verification, and publication. `tests/installation/tarball.test.js` still contains a fixed version; add isolated version-change coverage and retain negative metadata/file/digest checks. Existing code is a starting point, not full AC-S01/AC-S02 evidence.
