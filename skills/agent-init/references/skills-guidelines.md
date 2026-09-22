# Project Skills

A project Skill persists a project-specific task procedure whose combined assessment justifies durable guidance, not a technology stack label or source inventory. A technology indicator is a search seed; evaluate the evidenced task workflow that may sit behind it.

## Candidate evidence floor

Every plausible candidate records direct repository `evidenceIds` plus:

```yaml
skillAssessment:
  taskSpecificity: low | medium | high | unknown
  rediscoveryCost: low | medium | high | unknown
  errorCost: low | medium | high | unknown
  reuseFrequency: low | medium | high | unknown
targetedFollowUpSearch:
  queries: [focused task and workflow searches]
  paths: [repository-relative paths inspected]
  result: literal positive, partial, or negative result
  evidenceIds: [supporting evidence]
```

Assess the four dimensions qualitatively:

- **Task Specificity** — whether the evidence describes a named task and workflow rather than a technology category.
- **Rediscovery Cost** — the bounded effort needed to reconstruct the procedure, ordering, exceptions, and source links.
- **Error Cost** — the consequence of omitting or misordering the project-specific procedure.
- **Reuse Frequency** — how often future work is expected to trigger the workflow.

These are decision inputs, not a score, quota, or four binary gates. One low or unknown dimension does not automatically force `SKIP`; decide from the combined assessment and evidence floor. A repository may correctly produce zero Skills.

A `CREATE` or `UPDATE` evidence floor requires:

- direct repository evidence and evidence IDs
- a named task trigger (`When to use`)
- a clear exclusion (`When not to use`)
- at least one project-specific `workflowSteps` entry
- an exact `verification` method supported by repository evidence
- no duplicate of a compatible existing Skill or `GLOBAL` rule

A guessed build, test, migration, deploy, release, or verification command is never evidence. If targeted search leaves part of the workflow unsupported, retain that part as `Unknown` and make a grounded non-writing decision.

## Decision records

`CREATE` and `UPDATE` records carry the evidence floor, assessment, targeted search, triggers, exclusions, workflow steps, and verification. Name the Skill for the task—such as `build-verify`, `database-migration`, `audit-log`, or `deployment`—rather than Maven, Flyway, a logging framework, Redis, or another technology used by the task.

A `SKIP` record carries `evidenceIds`, `targetedFollowUpSearch`, and:

```yaml
skipBasis:
  dimensions: [taskSpecificity, rediscoveryCost, errorCost, reuseFrequency]
  explanation: substantive evidence-based reason persistence would not change behavior
```

List only dimensions that actually lower persistence value and explain what the bounded search found or failed to find. Model familiarity is not repository evidence and stays out of decision records; a discoverable fact or technology name is never the sole basis for `SKIP`. “Only a dependency/configuration was found; focused README, scripts, CI, and call-site searches found no project-specific procedure or verification” is grounded. “The model knows this technology” is not.

Before `CREATE`, match workflow intent against every existing Skill under `.agents/skills` and `.claude/skills`, even when names differ. Reuse the existing Skill with `KEEP` when it remains compatible; record `reuseExisting.path` plus `reuseExisting.compatibility`, and cite evidence whose `sourcePath` is that canonical Skill. Use `UPDATE` only for an evidence-backed conservative exact diff. If compatibility or merge safety is uncertain, issue `KEEP` with a warning or `decisionRequired`; never create a second Skill for the same workflow.

## Canonical form

The canonical source is `.agents/skills/<skill>/SKILL.md`. Use lowercase-hyphen directory/name and only shared frontmatter fields:

```yaml
---
name: <skill>
description: <what it does and when to use it>
---
```

The body is focused around `When to use`, `When not to use`, `Workflow`, `Project-specific rules`, `Verification`, and optional `References`. Completion criteria belong in `Verification` and must make successful task completion observable. Keep related branches in one workflow Skill when their trigger and completion criteria are shared; use conditional context pointers to `references/`, `docs/agents/`, or source for stage-specific detail. Do not copy `AGENTS.md`, a complete architecture model, or discoverable implementation detail.

## Claude sharing

Expose the same canonical Skill at `.claude/skills/<skill>`. Prefer a repository-relative symlink from the Claude target to `.agents/skills/<skill>`, and show its exact link text/destination in the Proposal. Validate without following unknown ancestors that it resolves to the intended canonical directory.

If symlink creation is unavailable, propose an explicit managed copy fallback. The complete copied content and fallback mode must be Proposal-visible, and validation must prove it exactly matches the approved canonical content. The copy remains an adapter, never a second canonical source.

## Preservation

Read existing `.agents/skills` and `.claude/skills` content before proposing changes. Preserve names, custom prose, references, scripts, and locally documented intent. Never replace a Skill because a detector found the same category. Reconcile through exact conservative diffs, or `KEEP` when compatibility is uncertain.
