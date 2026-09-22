# Agent Init

[简体中文](../README.md) | English

Agent Init installs a shared user-level `agent-init` Skill for six built-in harnesses and custom harnesses. Project-level environment generation still targets Claude Code and Codex: the Skill enters an existing repository, gathers evidence, proposes a minimal Agent environment, and writes only after explicit approval.

> Status: this document describes the current repository implementation. Multi-harness support has been merged, but no npm package has been published for these changes; `@latest` resolves to the published version and may not include the additions described below.
>
> License: MIT.

## Migrating from `@apparux/agent-project-setup`

This package was previously published as `@apparux/agent-project-setup`, which is now deprecated and will not receive updates. The two packages use different install roots and the new package does not migrate the old installation automatically. Migrate in this order:

```bash
# 1. Install the new package (if it reports existing targets, run step 2 first, then retry)
npx @apparux/agent-init@latest install

# 2. Uninstall the old package
npx @apparux/agent-project-setup@latest uninstall
```

Notes:

- During step 2, the old uninstaller may list entries such as `~/.claude/skills/project-setup` and `~/.agents/skills/project-setup` under `Preserved` with a `!` marker. This is expected, not a leftover: those paths were owned by the old package before the rename (or were created by it), so it refuses to delete what it no longer owns. Remove any leftover `~/.claude/skills/project-setup` / `~/.agents/skills/project-setup` entries manually after both steps complete if they still exist.
- If the old uninstall does leave dangling symlinks into `~/.agent-project-setup/` (check with `ls -la ~/.claude/skills`), remove them before running step 1.

## Requirements

- Node.js 18 or newer
- Linux, macOS, or WSL
- Windows Native is best-effort and may use the managed-copy fallback

## Install

The recommended installation path is `npx`, so a global package installation is not required:

```bash
npx @apparux/agent-init@latest install
```

The installer copies the canonical mother Skill into a stable location under:

```text
~/.agent-init/current/skills/agent-init
```

One canonical Skill is shared through individual discovery entries; the installer does not replace any harness's entire `skills` directory:

| Harness (ID) | Discovery target | How to use after installation |
| --- | --- | --- |
| Codex (`codex`) | `~/.agents/skills/agent-init` | `$agent-init` |
| Claude Code (`claude`) | `~/.claude/skills/agent-init` | `/agent-init` |
| Cursor (`cursor`) | `~/.cursor/skills/agent-init` | Type `/` in Agent chat and select `agent-init` |
| OpenCode (`opencode`) | `~/.config/opencode/skills/agent-init` | Ask the agent to load `agent-init` using its native `skill` tool |
| Pi (`pi`) | `~/.pi/agent/skills/agent-init` | `/skill:agent-init`, with skill commands enabled |
| Grok Build (`grok`) | `~/.grok/skills/agent-init` | `/agent-init` |

Each target normally symlinks to `~/.agent-init/current/skills/agent-init`. Where symlink creation is unavailable, the installer can fall back to a managed copy and records its mode and ownership evidence in `install.json`. Copies are synchronized by `update`, not live references. This fallback handles filesystem capabilities, not a harness refusing to discover symlinks.

Built-in `verification: documented` means the discovery convention has an official documentation basis, not that a live harness session has passed acceptance. `harnesses` checks installation state on disk; it does not test model selection or invocation. Invocation hints apply inside the respective harness, not in a shell; OpenCode's `skill({ name: "agent-init" })` is an agent tool call.

Official discovery and usage references: [Codex](https://learn.chatgpt.com/docs/build-skills), [Claude Code](https://code.claude.com/docs/en/skills), [Cursor](https://prod.cursor.com/docs/skills), [OpenCode](https://opencode.ai/docs/skills), [Pi](https://pi.dev/docs/latest/skills), and [Grok Build](https://docs.x.ai/build/features/skills-plugins-marketplaces). Codex documents `~/.agents/skills` as a user-level location; existing installations keep that path.

A future harness still needs compatible `SKILL.md` support and a known discovery location. A shared source alone cannot make every tool discover skills automatically.

### Custom harnesses

Add entries in `~/.config/agent-init/harnesses.json` (built-ins are retained):

```json
{
  "schemaVersion": 1,
  "harnesses": [
    {
      "id": "myagent",
      "label": "My Agent",
      "skillsDir": ".myagent/skills",
      "invocation": null
    },
    {
      "id": "shared-agent",
      "skillsDir": ".agents/skills"
    }
  ]
}
```

- `schemaVersion` must be `1`, and `harnesses` must be an array.
- `id` must match `^[a-z][a-z0-9-]*$` and must not duplicate a built-in or another custom ID.
- `skillsDir` is a directory relative to HOME, without `~` or an absolute path, and must stay inside HOME; the installer creates an `agent-init` target beneath it.
- `label` is optional and defaults to the ID. `invocation` is an optional display hint; omitted or `null` means no hint, not verified invocation support.
- If the normalized `skillsDir` matches an existing entry, the entry becomes an alias sharing its target and installation state, without a duplicate installation. Above, `shared-agent` shares the Codex target. Independent custom entries are marked `unverified`; aliases display `alias`.

Use `install` for a first installation. After adding configuration to an existing installation, use `update` to add the targets, then `harnesses` to inspect the result. Invalid configuration stops with an error rather than silently falling back to built-ins.

## CLI

Use the latest package payload for lifecycle operations:

```bash
npx @apparux/agent-init@latest install
npx @apparux/agent-init@latest update
npx @apparux/agent-init@latest doctor
npx @apparux/agent-init@latest harnesses
npx @apparux/agent-init@latest uninstall
npx @apparux/agent-init@latest --version
npx @apparux/agent-init@latest --help
```

If the package was installed globally, running `agent-init update` only applies the payload of that installed package. Use `npx @apparux/agent-init@latest update`, or update the global package first, to obtain the latest published payload.

### `install`

Creates the stable canonical installation and discovery targets for all built-in and custom harnesses (aliases share targets). Repeating a healthy same-version install with all targets present is a no-op. Unknown targets are never overwritten.

### `update`

Updates only the user-level mother Skill and managed targets; it does not scan or modify the current repository. If an older installation has only Claude/Codex targets, or configuration adds a custom harness, it adds registry targets not yet recorded in the manifest when existing managed assets are healthy and the new paths are unoccupied—even at the same version and payload. Only a healthy same-version, same-payload installation with all targets present reports that it is already up to date. Unknown targets, downgrade and integrity conflicts stop without replacing user data.

### `doctor`

Performs a read-only health check of the manifest, canonical Skill, ownership evidence, target modes and target contents. It does not repair files automatically.

### `harnesses`

Lists built-in, custom and alias harnesses with target paths, installation state, modes, `verification` and configured invocation hints, read-only. Targets still recorded in the manifest but absent from the current configuration also appear as `unregistered`. This command neither installs or repairs targets nor performs live harness acceptance.

### `uninstall`

Removes only user-level assets whose ownership can still be proven. Replaced, drifted or ambiguous targets are preserved and reported. Project files created through `agent-init` always survive uninstall.

## Project setup workflow

Invoking `agent-init` through the harness-specific method above operates on the current repository, independently of CLI `update`:

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
