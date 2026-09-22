# Apply, Validate, and Reconcile

## Exact write boundary

Only exact approved `CREATE` and `UPDATE` actions may write. `KEEP`, `SKIP`, and `RECOMMEND` are always non-writing. Writable targets are limited by both semantic kind and exact path:

- `AGENTS.md`
- `CLAUDE.md`
- canonical project Skill assets under `.agents/skills/<skill>/`
- Claude Skill references or Proposal-visible copies under `.claude/skills/<skill>`
- evidenced architecture documentation under `docs/agents/`

The broad spelling `.agents/`, `.claude/`, or `docs/agents/` is not blanket authority. Hooks, settings, permissions, local/override files, CI, manifests, databases, production configuration, business source, and user-default behavior remain untouched; Hook and CI mechanisms are recommendation-only in v0.1.

## Physical containment and drift

Before each write, normalize the repository-relative target and reject absolute paths, `..`, or malformed segments. Starting at the physical repository root, perform a component-by-component no-follow inspection of every existing target ancestor. Stop if an ancestor is a symlink, junction, reparse point, non-directory, unresolvable entry, or escapes the physical root. Lexical allowlisting alone never authorizes a write.

Recompute the Proposal baseline fingerprint immediately before each mutation. Any fingerprint drift invalidates approval and stops remaining writes. A target that was absent must still be absent. Never follow an unknown link to compare or overwrite content.

Apply in order: `AGENTS.md` → `CLAUDE.md` → canonical project Skills → Claude Skill references/copies → approved `docs/agents/` → validation. If a later action fails, report exact changed and unchanged paths and the failure context; do not perform an unapproved rewrite of user files as rollback.

## Preservation

Use read-existing → infer documented intent → compare evidenced desired state → identify conflict → show exact diff → merge after approval. Preserve AGENTS/CLAUDE/Skills/Hooks/settings/agent docs/override/local/Cursor/Copilot content and pre-existing business changes. Never delete-and-regenerate or apply unrelated formatting/reordering. When a safe merge is uncertain, stop at `KEEP`/warning.

## Validation

Prove that actual changed paths exactly equal approved actions and that forbidden business, CI, database, manifest, production, Hook/settings, and user-default paths did not change. Confirm evidence traceability, Unknown preservation, minimal `AGENTS.md`, thin `CLAUDE.md`, canonical Skill sharing, existing-content preservation, and generated Skill metadata/body contracts. With Git, compare final delta to Preflight and preserve the content/status of pre-existing staged, unstaged, and untracked business entries. A failed check blocks a completion claim.

## Reconcile

Every later run repeats full Preflight → Explore → Profile → Classify → Proposal; there is no hidden project manifest. Compare semantic intent and evidence, not wording preference. Do not rewrite equivalent prose or reorder Markdown. New or changed facts require new evidence and approval. Missing evidence triggers warning and a proposed conservative decision rather than automatic deletion.

An unchanged second dry-run should produce zero `CREATE`/`UPDATE` actions and zero write operations. Stable `KEEP`, `SKIP`, and recommendation summaries may be reported without filesystem churn. Project reconcile never updates the user-level mother Skill installation.

## Guardrails and architecture

Deterministic rules follow Detect → Explain → `RECOMMEND`; Apply does not install Hooks or edit CI/settings/permissions. Architecture follows Detect → Describe → Recommend. It may propose durable docs only when evidence and long-term value justify them. It never performs a production refactor, moves classes, creates business modules, or rewrites production code. When evidence is inadequate, record `EVALUATED / DEFER` rather than generating an empty architecture file.
