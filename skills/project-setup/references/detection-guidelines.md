# Detection and Evidence

Use this contract for Preflight, Explore, the runtime Project Profile, and the Evidence Ledger.

## Read-only sequence

Preflight and Explore are read-only. Snapshot the relevant tree/state before and after these phases when an executable harness is available; the snapshots must match. Optional `scripts/detect-project.js` may collect bounded facts, but native exploration remains the fallback and the helper never interprets them.

Use **Search → Read relevant → Cross-check**:

1. Search bounded indicators for repository root/shape, languages, runtimes, build and package systems, verification/CI, documentation, project workflows, and Agent configuration.
2. Read only sources relevant to a live question. Avoid whole-repository traversal.
3. Cross-check important conclusions against independent evidence where possible. Record conflicting evidence rather than choosing the convenient source.

Inventory `AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`, `CLAUDE.local.md`, `.agents/`, `.claude/` Skills/Hooks/settings/local settings, `docs/agents/`, `.cursor/`, and `.github/copilot-instructions.md`. Record whether an Agent target has pre-existing edits; use conservative `KEEP` or a conflict warning rather than overwriting it.

## Privacy boundary

Potential secret stores, credentials, private keys, tokens, and environment files are presence-only by default. Record “path exists” without reading or persisting values. Read a sensitive value only when the user explicitly authorizes it and the requested task cannot be completed without it; never place credentials or secret values in the ledger, Proposal, logs, or generated files.

## Project Profile

The runtime Project Profile covers repository root and Git state, single-project/monorepo shape, languages, runtimes, build/package systems, frameworks and persistence indicators, modules/packages, supported verification commands, existing Agent assets, project workflows, conflicts, and Unknowns. It is working memory, not a file to generate and not a hidden project manifest.

A fact is confirmed only when direct evidence supports its exact value. A named script proves its script name and quoted value; a framework or conventional filename does not prove an invocation command. Missing, ambiguous, conflicting, or inaccessible facts remain `Unknown`.

## Evidence Ledger

For every confirmed or persistence candidate, record:

- `id`
- `fact`
- repository-relative `sourcePath`
- exact `sourceLocation` or key
- literal `observation`, separate from interpretation
- `whyItMatters`
- persistence scope or Unknown
- independent `deterministicEnforcementCandidate` boolean
- destination or none

Every non-Unknown Project Profile conclusion and every Proposal action cites one or more ledger IDs. Use repository-relative paths without `..`. Evidence from outside the repository is not admissible. Record conflicting records side by side and downgrade the conclusion to conflicting/Unknown until resolved.

Complete detection when the profile can answer what was observed, where, why it matters, what remains Unknown, and how each persisted candidate traces to direct evidence—without mutating the repository or leaking sensitive values.
