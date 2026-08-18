# Knowledge Classification

Classify two independent dimensions: where knowledge belongs and whether deterministic enforcement is feasible. Never use the enforcement flag as a persistence scope.

## Persistence scope

Assign exactly one primary value:

| Scope | Use when | Destination |
|---|---|---|
| `GLOBAL` | Stable, broad, pre-action repository policy that most tasks must know before acting | `AGENTS.md`; `CLAUDE.md` only for evidenced Claude-specific content |
| `WORKFLOW` | Task-specific, project-specific procedure whose combined assessment justifies persisted steps and verification | `.agents/skills/<skill>/` |
| `DISCOVERABLE` | Task-local implementation fact reliably rediscovered from source, with no independent policy, workflow, or architecture value | none |
| `ARCHITECTURE` | Durable explanation of module seams, coupling, interfaces, or hotspots that should not stay always loaded | an existing suitable document or approved `docs/agents/`; `AGENTS.md` gets only a short pointer |
| `NONE` | Insufficient evidence or persistence value | none |

Decision order:

1. Insufficient or conflicting evidence becomes `Unknown`/`NONE`.
2. Check for repository-wide policy, specialized workflow, or durable architecture value.
3. Use `DISCOVERABLE` only when the fact is local and reliably rediscoverable and lacks those independent values.
4. Stable + broad + pre-action relevance qualifies for `GLOBAL`, even if its source can be searched later.
5. A task-specific, project-specific procedure qualifies for `WORKFLOW` when its evidence floor and combined Skill assessment justify persistence; no single assessment dimension is a hard gate.
6. Durable module-seam/coupling explanation may qualify for `ARCHITECTURE`.

A language, framework, dependency, directory, controller/service path, or other technology stack label alone does not create a Skill or global rule. Never fill an evidence gap with an industry convention or guessed command. `DISCOVERABLE` means a local fact stays at its source; it does not make a Skill decision for a related workflow. Model familiarity is not repository evidence and has no bearing on whether project procedure is worth persisting.

## Context load routing

Route each persisted meaning to one canonical destination with the lowest sufficient context load:

| Destination | Load | Use when |
|---|---|---|
| `AGENTS.md` | always loaded | A short, stable repository-wide rule is needed before most actions |
| `.agents/skills/<name>/SKILL.md` | trigger loaded | A named task needs a focused workflow, triggers, exclusions, project rules, and completion criteria |
| `.agents/skills/<name>/references/` | stage loaded | A workflow branch needs substantial detail or edge cases only at that stage; the Skill keeps a conditional context pointer |
| `docs/agents/` | explicitly loaded | Durable architecture, coupling, or interface knowledge spans workflows; `AGENTS.md` holds only the pointer |
| runtime source/config | runtime discovery | Volatile paths, implementation facts, and exact source-of-truth values are cheap to rediscover |

Domain knowledge follows the repository's canonical `CONTEXT.md` and `docs/adr/` layout described by `docs/agents/domain.md`; do not create a competing domain source under `docs/agents/`.

Apply the no-op test before persistence: if deleting the proposed text would not materially change Agent behavior, leave it at runtime discovery. Keep related steps in one workflow Skill unless their triggers and completion criteria genuinely differ. Point to canonical references, docs, or source instead of copying them; one meaning has one source of truth.

## Deterministic enforcement

Set `deterministicEnforcementCandidate: true` only when a script, Hook, CI check, or permission could reliably decide compliance. This boolean is independent: a pnpm policy can be both `GLOBAL` and deterministic; a workflow can also be deterministic.

In v0.1 the flag produces only a Proposal `RECOMMEND`. Cite evidence and describe mechanism, expected impact, false-positive risk, and verification. It never authorizes installing Hooks, changing CI, editing permissions/settings, or modifying user-default behavior.

## Architecture evaluation

Analyze architecture only from evidence. Detect and describe module seams, coupling, public interfaces, or hotspots, then recommend rather than refactor. If fixtures/build descriptors do not establish enough durable value, record `EVALUATED / DEFER` with the evidence gap. Architecture analysis never moves classes, creates business modules, rewrites production code, or turns a recommendation into an implementation action.
