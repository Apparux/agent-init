# Shared Agent Instructions

`AGENTS.md` is the repository's shared source of truth. `CLAUDE.md` is normally a thin Claude Code adapter, not a second shared rule set.

## AGENTS.md

Persist only evidenced `GLOBAL` knowledge: stable, broad, pre-action constraints most tasks need. Include a section only when it has content; useful headings may include Environment, Working Principles, Verification, Project Knowledge, and Safety.

Keep it minimal and scannable. Link to focused Skills or durable architecture material rather than copying them. Omit complete project summaries, directory trees, dependency inventories, module/class/method lists, transient implementation paths, discoverable source facts, and generic best practices without repository evidence.

For an existing file, read its intent and propose a conservative exact diff. Preserve custom prose, comments, ordering, formatting, override/local behavior, and unrelated sections. Merge only the evidenced delta. Never delete-and-regenerate, wholesale reformat, or reorder unrelated Markdown. If intent conflicts or a safe merge is unclear, use `KEEP` or `RECOMMEND` with a warning and `decisionRequired`.

## CLAUDE.md adapter

When creating a new adapter, default to exactly:

```markdown
@AGENTS.md
```

Append content only when direct Claude-specific evidence requires a rule that does not belong in the shared source. Cite that Claude-specific evidence in the Proposal. Never copy shared `AGENTS.md` rules into `CLAUDE.md`.

Existing `CLAUDE.md` and `CLAUDE.local.md` content is user configuration. Preserve it and integrate `@AGENTS.md` only through a conservative exact diff when compatibility is clear and explicitly approved. A conflict produces `KEEP`/warning rather than replacement.

## Other Agent configuration

Explore and preserve `AGENTS.override.md`, `.claude` settings/Hooks/local files, existing Skills, `docs/agents`, `.cursor`, and Copilot instructions. These sources may constrain reconciliation even when they are not writable defaults. Hooks, settings, permissions, CI, and user-default behavior are recommendation-only in v0.1.
