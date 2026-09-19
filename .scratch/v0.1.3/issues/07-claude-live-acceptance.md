# 07 — APS-041 — Record real Claude Code routing in fresh sessions

**Status:** ready-for-agent
**Milestone:** 7 — Real Trigger Qualification
**Blocked by:** APS-040 — Executable trigger corpus and acceptance artifact contract.
**PRD requirements:** [PRD.md](../../../PRD.md) §15–16, §18.

**What to build:** A concrete Claude Code acceptance runner installs the current package into a disposable environment, uses the mother Skill to generate approved fixture assets, then records real Skill selection in a separate fresh session.

## Scope and implementation boundaries

Reuse APS-040 fixture/artifact/digest logic and existing isolated-home helpers. Implement only the Claude-specific invocation and observation necessary for this protocol. Use the actual supported Harness interface and version; do not assume an undocumented trace format or equate a generated answer with proof of Skill loading.

PRD.md remains the sole specification; §4–5 and §42 apply. Live execution requires an available authorized Harness session/account. Do not copy credentials into fixtures or artifacts, modify the real HOME, mutate permissions, or install hooks. Missing access is a reported blocker, never a simulated live pass. Configuration or credential-related operations retain their separate approval requirements.

## Acceptance criteria

- [ ] The runner creates a disposable HOME and fixture repository, installs the current package, and records the exact tested payload digests.
- [ ] A fresh real Claude Code session runs `/project-setup`; the generated fixture Proposal is explicitly approved and applied without bypassing the existing approval contract.
- [ ] The setup session closes before routing begins; each independent routing case starts without setup or prior-case conversation context.
- [ ] Required corpus categories and explicit Skill invocation probes are executed using real prompts.
- [ ] Actual selected Skills are extracted from observable Harness evidence; malformed/missing traces or execution failures produce an explicit non-pass outcome rather than inferred success.
- [ ] Artifacts contain Harness version and current digests, retain sufficient non-secret selection evidence for review, and pass APS-040 validation.
- [ ] At least one complete real execution demonstrates installation, approved generation, session separation, selection recording, and artifact validation; routing mismatches are recorded honestly for APS-043 rather than hidden.
- [ ] Cleanup is limited to owned disposable assets; secrets and real user files are not modified or included in artifacts.

## Verification

Test runner orchestration and trace parsing with clearly marked doubles, including unavailable Harness, malformed output, and session failure. Then run the real protocol with separately authorized access. Run `npm test`. Report deterministic tests and live outcomes separately; a mocked run does not satisfy the real-execution criterion. Review isolation, credential handling, and cleanup boundaries.
