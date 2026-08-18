# Audit log workflow

## When to use

Use this workflow when adding or changing an auditable domain operation.

## Rules

Record `actor`, `action`, and `resource` through `AuditService` at each audited call site.

## Verification

Run `mvn -Dtest=AuditLogContractTest test` and confirm the required event fields remain present.
