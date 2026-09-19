# 08 — APS-042 — Record real Codex routing in fresh sessions

**Status:** ready-for-agent
**Milestone:** 7 — Real Trigger Qualification
**Blocked by:** APS-040 — Executable trigger corpus and acceptance artifact contract.
**PRD requirements:** [PRD.md](../../../PRD.md) §15, §17–18.

**What to build:** A concrete Codex acceptance runner follows the same observable setup-and-routing protocol as Claude while keeping the Harness-specific invocation and selection observation explicit.

## Scope and implementation boundaries

Reuse only shared fixture preparation, artifact schema, digest calculation, and result evaluation. Do not depend on the Claude runner, build an interchangeable-Agent framework, or duplicate the mother Skill. Use the current supported Codex interface and record the actual Harness version.

PRD.md remains the sole specification; §4–5 and §42 apply. Live execution requires authorized access. Never copy credentials into fixtures or output, mutate the real user environment, weaken permissions, or silently fall back to a mock. Report unavailable authentication/Harness support as a blocker. Any environment or credential action remains separately permission-gated.

## Acceptance criteria

- [ ] The runner prepares a disposable environment, installs the current package, and prepares a repository from the versioned fixture.
- [ ] A fresh real Codex session invokes `$project-setup`, produces the exact fixture Proposal, and applies only explicitly approved actions.
- [ ] Setup context is discarded before routing; independent cases use fresh sessions without prior-case context contamination.
- [ ] Corpus prompts and explicit invocation probes produce actual observable Skill-selection evidence, not merely answer text suggesting that a workflow was followed.
- [ ] Missing/malformed observations and execution failures remain non-pass outcomes; genuine observed no-load results can be evaluated normally.
- [ ] Recorded artifacts contain actual Harness version and payload digests and pass the shared APS-040 validator.
- [ ] At least one complete real run proves install, generation, approval, session separation, and artifact capture; failed routing expectations are retained rather than relabeled.
- [ ] Only owned disposable assets are cleaned up, and no artifact includes credentials or unrelated user content.

## Verification

Use isolated orchestration/trace-parser tests for failure and success paths, explicitly marking test doubles as synthetic. Execute the real protocol with separately authorized access and retain reviewable non-secret evidence. Run `npm test`. Distinguish real acceptance from local deterministic tests and review isolation/credential/cleanup safety. Neither runner's result substitutes for the other Harness.
