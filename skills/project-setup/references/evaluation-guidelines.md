# Evaluation Protocol

Use this protocol when evaluating behavior in actual Harnesses or reporting acceptance. Local tests validate static instruction structure, helper behavior, fixture/record schemas, recorded-run invariants, and filesystem evidence. They do not execute a model and cannot prove discovery, invocation, approval behavior, or output quality.

## Prepare

Use a disposable copy of one named fixture and record its initial recursive filesystem state, including content fingerprints, entry types, link text, and relevant modes. Do not initialize Git for a no-Git fixture. Ensure the installed mother Skill is the intended canonical version, but remember: target path existence does not prove Harness discovery or invocation.

For every run record:

- Harness and version
- fixture ID and restored initial-state digest
- fresh-session identifier or timestamp
- invocation used
- Proposal ID/revision and complete Proposal output
- approval or rejection input exactly as supplied
- before/after filesystem evidence
- validation and second-run evidence
- result status and limitations

Store only named evidence references in fixture acceptance status. Exclude credentials and secret values.

## Fresh Claude Code

Start a fresh Claude Code session in the disposable fixture. Verify `project-setup` appears in its discovery catalog, invoke `/project-setup`, and record evidence that the canonical Skill version/content was loaded. Filesystem target existence alone is insufficient.

First run the **no-approval** branch: allow Preflight through Proposal, then reject or withhold approval. Verify Proposal appears before any write and the before/after tree proves zero writes.

For an approved representative branch, restore the fixture, start another fresh session, invoke the Skill, capture the exact Proposal, explicitly approve its Proposal ID, revision, and selected action IDs, and verify the actual delta and validation output. Run a second read-only reconcile and expect zero write actions if unchanged.

## Fresh Codex

Repeat the same procedure in a fresh Codex session using `$project-setup`: catalog discovery, actual invocation, loaded canonical version/content, no-approval Proposal with zero writes, then an approved representative branch where required. Do not infer Codex behavior from Claude results.

After a generated project Skill is approved and applied, start fresh sessions in both Harnesses and independently prove the project Skill is discovered, invocable, and loads the same `.agents/skills/<skill>` canonical content (or the exact Proposal-visible managed-copy fallback).

## Reporting

Use `not-run` when a Harness check was not executed. Use a passed/failed external status only with named evidence sufficient to reproduce the claim. Distinguish model output assessment from local recorded-artifact validation. A local evaluator passing means its record satisfies declared invariants; it does not certify that a live Claude Code or Codex session produced that record.
