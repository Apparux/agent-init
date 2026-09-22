# 25 — AI-059 — Enforce final release gates and verify published artifact evidence

**Status:** ready-for-agent
**Milestone:** 10 — Qualification
**Blocked by:** AI-057 — Qualification artifact and traceability; AI-058 — Final lifecycle extraction.
**PRD requirements:** [PRD.md](../../../PRD.md) §3, §39, §43; §36–37 evidence contract.

**What to build:** The final release can be declared 100% Qualified only when every required deterministic, cross-platform, live-Harness, traceability, and artifact check has current evidence for the exact payload, including registry verification after an independently authorized publish.

## Approved sequencing clarification

The user approved this interpretation of the §39/§43 ordering conflict without rewriting PRD.md:

1. Before publish, all executable pre-publish gates, current dual-Harness acceptance, and release artifact digest verification must pass.
2. Publishing remains a separate explicitly authorized action through the existing release process; ticket approval is not publish authorization.
3. After publish, verify the registry artifact digest against the tested release payload.
4. Only then may the actual release be marked 100% Qualified. Before registry verification it remains unqualified, not a bootstrap exception or provisional Qualified release.

## Scope and implementation boundaries

Connect the existing checks/runners and AI-057 evidence consumer to the release gate with the smallest workflow/verifier changes. Reuse package metadata SSOT, current artifact digest logic, existing CI platforms, fixture/mutation suites, and the two concrete Harness runners. Do not create commit/push/PR automation, a new release framework, automatic credential provisioning, or a publish bypass.

PRD.md remains the sole specification; §4–5 and §42 apply. CI/configuration edits and remote actions retain their separate approval requirements. Keep credentials out of artifacts and logs. Missing live access or registry evidence blocks qualification rather than weakening the contract.

## Acceptance criteria

- [ ] Pre-publish evidence includes passing `npm test`, Ubuntu, macOS, and native Windows checks for the final payload.
- [ ] Packed-package lifecycle, installation crash/recovery, ownership/race/no-follow, full project fixture matrix, evaluator mutation matrix, context architecture, and pruning lifecycle checks all pass.
- [ ] Claude and Codex real acceptance are each CURRENT + PASS for the exact bound inputs; all PRD trigger thresholds pass with complete case inventories.
- [ ] Acceptance traceability is complete and every qualification pass resolves to actual current evidence, not a declaration or synthetic test artifact.
- [ ] The release artifact's digest is verified against the tested package; changing any relevant final input invalidates affected evidence and requires rerunning the corresponding checks.
- [ ] Pre-publish failures prevent the existing release process from proceeding; local unavailable checks cannot silently become successful release checks.
- [ ] Actual publication is performed only after a separate explicit authorization. If authorization/access is absent, verification stops at the pre-publish boundary and reports the remaining blocker.
- [ ] After publication, registry package/version/artifact digest verification proves correspondence to the tested release payload. Missing package, mismatch, or registry-verification failure prevents 100% Qualified.
- [ ] The final release-qualification artifact contains all nine passing dimensions only after all required evidence, including registry verification, is present and valid.
- [ ] Negative gate tests independently cover missing, stale, and failed evidence, digest mismatch, absent platform/Harness evidence, and incomplete traceability.
- [ ] The final end-to-end evidence follows the PRD §43 flow: install/discovery, approved setup, valid generated metadata, both fresh-session routings, safe reconcile/retirement, valid references, zero-write second run, complete regressions, and verified registry artifact.

## Verification

Run deterministic gate tests first and `npm test`; execute the existing final package/platform/fixture/mutation checks and actual live runners for the final payload with appropriate authorization. Generate and inspect the qualification artifact, validating every evidence link and digest. Separately authorize publish and then verify the registry artifact. Report pre-publish readiness and final qualification as distinct outcomes. Review workflow permission, credential, digest, freshness, and fail-closed behavior; do not claim completion when a required real check was skipped.

## Comments

### 2026-09-22 — Merged baseline: `bdf2999`

- Existing artifact subgate: reuse `scripts/release-manifest.js`, `release-manifest.json`, `.github/workflows/ci.yml`, and `.github/workflows/release.yml` for package tree/file/mode checks and post-publication registry/artifact digest verification. Their presence does not establish complete release qualification.
- Remaining: wire current nine-dimension qualification, traceability, Claude/Codex CURRENT + PASS, and matching-commit cross-platform CI evidence into the fail-closed release decision. Include registry/custom/alias, legacy reconcile, orphan uninstall, and recovery regressions in final lifecycle evidence; keep project pruning and real routing as separate obligations. Publication still requires separate authorization.
