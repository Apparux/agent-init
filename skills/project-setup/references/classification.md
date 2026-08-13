# Knowledge Classification

Classify two independent dimensions: where knowledge belongs and whether deterministic enforcement is feasible. Never use the enforcement flag as a persistence scope.

## Persistence scope

Assign exactly one primary value:

| Scope | Use when | Destination |
|---|---|---|
| `GLOBAL` | Stable, broad, pre-action repository policy that most tasks must know before acting | `AGENTS.md`; `CLAUDE.md` only for evidenced Claude-specific content |
| `WORKFLOW` | Task-specific, repeated, project-specific procedure needing steps and verification | `.agents/skills/<skill>/` |
| `DISCOVERABLE` | Task-local implementation fact reliably rediscovered from source, with no independent policy, workflow, or architecture value | none |
| `ARCHITECTURE` | Durable explanation of module seams, coupling, interfaces, or hotspots that should not stay always loaded | an existing suitable document or approved `docs/agents/`; `AGENTS.md` gets only a short pointer |
| `NONE` | Insufficient evidence or persistence value | none |

Decision order:

1. Insufficient or conflicting evidence becomes `Unknown`/`NONE`.
2. Check for repository-wide policy, specialized workflow, or durable architecture value.
3. Use `DISCOVERABLE` only when the fact is local and reliably rediscoverable and lacks those independent values.
4. Stable + broad + pre-action relevance qualifies for `GLOBAL`, even if its source can be searched later.
5. Task-specific + repeated + project-specific + procedural/verification value qualifies for `WORKFLOW`.
6. Durable module-seam/coupling explanation may qualify for `ARCHITECTURE`.

A language, framework, dependency, directory, controller/service path, or other technology stack label alone does not create a Skill or global rule. Never fill an evidence gap with an industry convention or guessed command.

## Deterministic enforcement

Set `deterministicEnforcementCandidate: true` only when a script, Hook, CI check, or permission could reliably decide compliance. This boolean is independent: a pnpm policy can be both `GLOBAL` and deterministic; a workflow can also be deterministic.

In v0.1 the flag produces only a Proposal `RECOMMEND`. Cite evidence and describe mechanism, expected impact, false-positive risk, and verification. It never authorizes installing Hooks, changing CI, editing permissions/settings, or modifying user-default behavior.

## Architecture evaluation

Analyze architecture only from evidence. Detect and describe module seams, coupling, public interfaces, or hotspots, then recommend rather than refactor. If fixtures/build descriptors do not establish enough durable value, record `EVALUATED / DEFER` with the evidence gap. Architecture analysis never moves classes, creates business modules, rewrites production code, or turns a recommendation into an implementation action.
