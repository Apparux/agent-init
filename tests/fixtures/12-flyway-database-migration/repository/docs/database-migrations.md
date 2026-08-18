# Database migrations

## Workflow

1. Inspect the highest published migration version.
2. Add a new `V<next>__description.sql` file; published migrations remain unchanged.
3. Run `mvn -Pdatabase-migration flyway:migrate`.

## Verification

Run `mvn -Pdatabase-migration flyway:validate` after migration. The complete workflow is `mvn -Pdatabase-migration flyway:migrate && mvn -Pdatabase-migration flyway:validate`.
