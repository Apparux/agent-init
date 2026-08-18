# Agent Project Setup

[简体中文](../README.md) | English

Agent Project Setup installs a shared `project-setup` Skill for Claude Code and Codex. The Skill enters an existing repository, gathers evidence, proposes a minimal Agent environment, and writes only after explicit approval.

> Status: v0.1.1.
>
> License: MIT.

## Requirements

- Node.js 18 or newer
- Linux, macOS, or WSL
- Windows Native is best-effort and may use the managed-copy fallback

## Install

The recommended installation path is `npx`, so a global package installation is not required:

```bash
npx @apparux/agent-project-setup@latest install
```

The installer copies the canonical mother Skill into a stable location under:

```text
~/.agent-project-setup/current/skills/project-setup
```

It then exposes that same canonical Skill to both harnesses:

```text
~/.agents/skills/project-setup
~/.claude/skills/project-setup
```

A symlink is preferred. Where a stable, ownership-verifiable symlink cannot be created, the installer may use a managed copy and records that mode in `install.json`.

After installation:

- Claude Code: `/project-setup`
- Codex: `$project-setup`

## CLI

Use the latest package payload for lifecycle operations:

```bash
npx @apparux/agent-project-setup@latest install
npx @apparux/agent-project-setup@latest update
npx @apparux/agent-project-setup@latest doctor
npx @apparux/agent-project-setup@latest uninstall
npx @apparux/agent-project-setup@latest --version
npx @apparux/agent-project-setup@latest --help
```

If the package was installed globally, running `agent-project-setup update` only applies the payload of that installed package. Use `npx @apparux/agent-project-setup@latest update`, or update the global package first, to obtain the latest published payload.

### `install`

Creates the stable canonical installation and the Claude/Codex discovery targets. Repeating a healthy same-version install is a no-op. Unknown targets are never overwritten.

### `update`

Updates only the user-level mother Skill and targets owned by this installer. It does not scan or modify the current repository. A same-version, same-payload healthy installation reports that it is already up to date; downgrade and integrity conflicts stop without replacing user data.

### `doctor`

Performs a read-only health check of the manifest, canonical Skill, ownership evidence, target modes and target contents. It does not repair files automatically.

### `uninstall`

Removes only user-level assets whose ownership can still be proven. Replaced, drifted or ambiguous targets are preserved and reported. Project files created through `project-setup` always survive uninstall.

## Project setup workflow

`/project-setup` and `$project-setup` operate on the current repository, independently of CLI `update`:

1. Preflight and read-only exploration
2. Project Profile and evidence ledger
3. Knowledge classification
4. Project-specific workflow detection
5. A proposal showing exact create/update/keep/skip/recommend actions
6. Explicit user approval
7. Scoped apply and validation

Without explicit approval, the repository is not changed. If a proposed target changes between proposal and apply, the approval is invalidated and a new proposal is required.

By default, the Skill may propose changes only under:

```text
AGENTS.md
CLAUDE.md
.agents/
.claude/
docs/agents/
```

It does not modify business source, build manifests, CI, databases or production configuration. Guardrails and architecture improvements are recommendations only in v0.1: the Skill does not install hooks, change permissions, edit CI, or refactor production code.

Facts without sufficient repository evidence remain `Unknown`. Existing Agent files and Skills are read and conservatively reconciled rather than deleted and regenerated.

## Generated layout

A repository may receive only the assets justified by evidence. A typical result is:

```text
AGENTS.md                         shared minimal rules
CLAUDE.md                        thin adapter importing @AGENTS.md
.agents/skills/<name>/SKILL.md   canonical project workflow
.claude/skills/<name>            reference to the canonical workflow
docs/agents/                     optional long-lived architecture guidance
```

Technology detection alone does not create a Skill. Project Skills require a repeated, project-specific workflow with explicit triggers and verification.

## Safety model

- Installation tests and lifecycle checks use an isolated temporary HOME.
- Managed paths are validated before mutation.
- Unknown files and links are not adopted based on similar content.
- Doctor is strictly read-only.
- Uninstall does not search repository paths or delete discovery-target parent directories.
- Project apply is proposal-gated and limited to approved paths.
- Credentials and repository secrets are not stored in `install.json` or generated Agent assets.

## Development

```bash
npm test
npm pack --dry-run
```

Tests use Node's built-in test runner and require no build step. Release acceptance additionally requires deterministic Skill contract and fixture validation, supported-platform validation, a license decision, registry authorization, and an explicit publish decision. Live Claude Code or Codex login is not a release gate.
