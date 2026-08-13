# Project Skills

A project Skill persists a repeated project-specific procedure, not a technology stack label or source inventory.

## Candidate gate

A writable candidate requires all of:

- direct repository evidence and evidence IDs
- a named task trigger (`When to use`)
- a clear exclusion (`When not to use`)
- repeated expected use
- project-specific procedural knowledge beyond a few global rules
- an exact verification method supported by repository evidence
- no duplication of `GLOBAL` rules or an existing Skill

A language, framework, dependency, directory, architecture category, or technology stack alone is insufficient. A guessed build/test/deploy/release command is forbidden. If any gate is missing, issue `SKIP` with the missing reason. If an existing Skill cannot be merged safely, issue `KEEP` plus warning/`decisionRequired`.

## Canonical form

The canonical source is `.agents/skills/<skill>/SKILL.md`. Use lowercase-hyphen directory/name and only shared frontmatter fields:

```yaml
---
name: <skill>
description: <what it does and when to use it>
---
```

The body is focused around `When to use`, `When not to use`, `Workflow`, `Project-specific rules`, `Verification`, and optional `References`. Do not copy `AGENTS.md`, a complete architecture model, or discoverable implementation detail.

## Claude sharing

Expose the same canonical Skill at `.claude/skills/<skill>`. Prefer a repository-relative symlink from the Claude target to `.agents/skills/<skill>`, and show its exact link text/destination in the Proposal. Validate without following unknown ancestors that it resolves to the intended canonical directory.

If symlink creation is unavailable, propose an explicit managed copy fallback. The complete copied content and fallback mode must be Proposal-visible, and validation must prove it exactly matches the approved canonical content. The copy remains an adapter, never a second canonical source.

## Preservation

Read existing `.agents/skills` and `.claude/skills` content before proposing changes. Preserve names, custom prose, references, scripts, and locally documented intent. Never replace a Skill because a detector found the same category. Reconcile through exact conservative diffs, or `KEEP` when compatibility is uncertain.
