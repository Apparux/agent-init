# Proposal and Approval

A Proposal is the complete, versioned write plan and the only source of Apply authority.

## Required presentation

Show:

- Proposal ID and revision
- detected project summary
- evidence-backed facts
- explicit Unknowns, conflicts, warnings, and unresolved decisions
- exact actions and targets
- explicit files/categories that will not change
- validation plan

Use only `CREATE`, `UPDATE`, `KEEP`, `SKIP`, and `RECOMMEND`. An unresolved choice stays a warning plus `decisionRequired`; do not invent a sixth action.

Each action includes exact target, reason, evidence IDs, validation, and decision status. A `CREATE` shows the **full proposed content** and a `missing` baseline. An `UPDATE` shows the **exact proposed diff** and the existing target baseline. `KEEP`, `SKIP`, and `RECOMMEND` show a summary and never carry or trigger a write payload.

Guardrail `RECOMMEND` actions also show the evidenced rule, suggested mechanism, expected impact, false-positive risk, and verification. They remain non-writing even if approved.

## Baseline fingerprints

Fingerprint every writable target during Proposal:

- ordinary file: content SHA-256
- directory: deterministic tree digest over sorted normalized relative paths, entry types, file contents, and relevant executable bits
- symlink: link text plus normalized destination, without following it
- absent target: explicit `missing`

Exclude absolute path, mtime, and traversal order. Re-read and recompute immediately before mutation. Any mismatch is fingerprint drift: stop with zero additional writes and issue a new Proposal after re-exploration.

## Explicit approval

Ask the user to explicitly approve or reject the exact Proposal ID, revision, and action IDs. Only enumerated `CREATE`/`UPDATE` actions unlock Apply. “Looks good,” general encouragement, silence, approval of an earlier revision, or approval without exact scope is not authorization.

A requested change, added/removed target, content/diff revision, new evidence, changed baseline, or altered validation plan creates a new revision and invalidates every earlier approval. Partial approval authorizes only the named write actions; report all others as not approved. Rejection writes nothing.

Before Apply, bind each prospective write to the approved Proposal ID, revision, action ID, exact target, exact payload/diff, and baseline fingerprint. Being somewhere under an allowed directory is insufficient.
