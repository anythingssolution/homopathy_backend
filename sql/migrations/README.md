# Managed database migrations

Only SQL files in this directory run automatically before the backend starts.
Legacy bootstrap and manual files in `sql/` are intentionally excluded.

## Add a migration

1. Create a file named `YYYY-MM-DD_NNN_description.sql`.
2. Make every statement safe to retry because MySQL DDL can commit before a later statement fails.
3. Keep changes backward-compatible with the currently running application during a rolling deploy.
4. Commit the migration together with the backend code that needs it.
5. Run `npm test` and, when a database is available, `npm run migrate`.

Applied filenames and SHA-256 checksums are stored in `schema_migrations`. Never edit,
rename, or delete an applied file; add a new migration instead. A `RUNNING` or `FAILED`
row deliberately blocks startup until the production schema is inspected and reconciled.

The runner rejects MySQL client-only directives such as `DELIMITER`, `SOURCE`, and `USE`.
It executes each trusted migration as a whole on a dedicated connection with
`multipleStatements` enabled. The application connection pool remains unchanged.

This directory is an existing-production baseline, not a fresh database bootstrap.
For a new AWS/MySQL database, first restore a verified production backup (or run the
audited bootstrap schema), then let this runner apply migrations newer than that baseline.
