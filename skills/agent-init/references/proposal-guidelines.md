# Proposal and Approval

A Proposal is the complete, versioned write plan and the only source of Apply authority. Render it in two layers: a human decision surface first, then the complete audit surface needed to inspect the exact writes.

## Decision summary

Always show this section first, in the user's language. Preserve literal paths, commands, Proposal identifiers, revisions, and action IDs even when the surrounding explanation is localized.

Keep the opening summary short and decision-oriented:

- Start with the explicit state: **No files have been written.**
- Show the Proposal ID and revision.
- Under a clear “will change” heading, list only `CREATE` and `UPDATE` write actions. For each, show its action ID, exact target, and a one-sentence plain-language reason.
- Under a clear “will not write” heading, group `KEEP`, `SKIP`, and `RECOMMEND` as non-writing decisions and summarize each without implementation detail.
- Show only Unknowns, conflicts, warnings, or unresolved choices that affect the user's decision. State when none block the proposed writes.
- State the important files or categories that will not change, including forbidden business, CI, settings, Hook, permission, production, remote, or user-level surfaces relevant to the run.
- End with the recommended scope and a copy-ready approval sentence containing the exact Proposal ID, revision, and `CREATE`/`UPDATE` action IDs. Also state how to reject or approve a smaller exact subset. Use the user's language around literals; for example: `Approve Proposal <id> revision <revision>, actions <A1, A2>.`

Aim to keep this section within one terminal screen when the action list permits. Do not put raw fingerprints, full Evidence Ledger rows, repeated validation steps, detector output, or field-by-field internal classifications in the decision summary. Do not replay the exploration transcript. The summary may explain `CREATE`, `UPDATE`, `KEEP`, `SKIP`, and `RECOMMEND` in plain language, but must keep the canonical labels and IDs visible.

The summary is derived presentation and does not authorize Apply. It must agree with the canonical Proposal. If the summary and audit details disagree, Apply stays locked and a corrected Proposal revision is required.

## Audit details

Place this section after the decision summary in the same Proposal, before asking for approval. It remains fully inspectable; summary-first presentation must not hide or omit an approved payload.

Show:

- Proposal ID and revision
- detected project summary needed to understand the actions
- evidence-backed facts cited by an action, warning, Unknown, or validation claim
- explicit Unknowns, conflicts, warnings, and unresolved decisions that affect persistence or safety
- every exact action and target
- explicit files/categories that will not change
- one deduplicated validation plan

Do not print runtime-only Project Profile fields, detector output, or Evidence Ledger entries classified `DISCOVERABLE`/`NONE` solely for completeness when they do not support an action, warning, Unknown, or validation claim. Keep those facts available during the run without turning the Proposal into an exploration log.

Use only `CREATE`, `UPDATE`, `KEEP`, `SKIP`, and `RECOMMEND`. An unresolved choice stays a warning plus `decisionRequired`; do not invent a sixth action.

Each action includes exact target, reason, evidence IDs, validation, and decision status. A `CREATE` shows the **full proposed content** and a `missing` baseline. An `UPDATE` shows the **exact proposed diff** and the existing target baseline. `KEEP`, `SKIP`, and `RECOMMEND` show a compact summary and never carry or trigger a write payload.

Present baselines and fingerprints once in a compact audit table when possible instead of repeating the same hash throughout the prose. Present shared validation steps once and reference them from actions instead of duplicating the full plan under every action.

Guardrail `RECOMMEND` actions also show the evidenced rule, suggested mechanism, expected impact, false-positive risk, and verification in the audit details. They remain non-writing even if named in a response.

## Baseline fingerprints

Fingerprint every writable target during Proposal:

- ordinary file: content SHA-256
- directory: deterministic tree digest over sorted normalized relative paths, entry types, file contents, and relevant executable bits
- symlink: link text plus normalized destination, without following it
- absent target: explicit `missing`

Exclude absolute path, mtime, and traversal order. Re-read and recompute immediately before mutation. Any mismatch is fingerprint drift: stop with zero additional writes and issue a new Proposal after re-exploration.

## Explicit approval

Ask the user to explicitly approve or reject the exact Proposal ID, revision, and action IDs. Only enumerated `CREATE`/`UPDATE` actions unlock Apply. “Looks good,” “approve all,” general encouragement, silence, approval of an earlier revision, or approval without exact scope is not authorization.

The copy-ready sentence in the decision summary is a convenience, not a weaker approval grammar. If the user's response omits or ambiguously names the Proposal ID, revision, or write action IDs, restate the exact sentence and keep Apply locked. Never infer that `KEEP`, `SKIP`, or `RECOMMEND` became writable.

A requested change, added/removed target, content/diff revision, new evidence, changed baseline, or altered validation plan creates a new revision and invalidates every earlier approval. Partial approval authorizes only the named write actions; report all others as not approved. Rejection writes nothing.

Before Apply, bind each prospective write to the approved Proposal ID, revision, action ID, exact target, exact payload/diff, and baseline fingerprint. Being somewhere under an allowed directory is insufficient.
