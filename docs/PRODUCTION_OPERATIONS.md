# Production operations

This is the handoff checklist for the first online deployment. It deliberately
keeps secrets out of the repository; values belong in Vercel and GitHub Actions
secret stores.

## Database recovery

Neon provides point-in-time restore for the configured history window. Before
the first public deployment, set a daily snapshot schedule on the production
branch (the Neon Console's **Backup & restore** page, or the equivalent Neon
CLI/API command) and confirm the retention period with the project owner.

For an independent, longer-lived copy, the repository includes a nightly
GitHub Actions workflow at `.github/workflows/db-backup.yml`. Add these
repository secrets before enabling it:

| Secret | Value |
| --- | --- |
| `BACKUP_DATABASE_URL` | The unpooled production connection string (never a `-pooler` host). Set this when the database moves provider; `NEON_DIRECT_DATABASE_URL` is the old name and still works as a fallback |
| `RESTORE_TARGET_DATABASE_URL` | Where `db-restore.yml` writes. Must not be the backup source unless `confirm=RESTORE-OVER-LIVE` |
| `BACKUP_S3_BUCKET` | A private S3-compatible backup bucket |
| `BACKUP_S3_ACCESS_KEY_ID` | Write credential for that bucket |
| `BACKUP_S3_SECRET_ACCESS_KEY` | Matching secret key |
| `BACKUP_S3_REGION` | Bucket region (`us-east-2`, `auto`, etc.) |
| `BACKUP_S3_ENDPOINT` | Optional endpoint for Neon Object Storage/R2/MinIO; leave blank for AWS S3 |

The optional repository variable `BACKUP_S3_PREFIX` defaults to `postgres`.
The workflow uses a PostgreSQL 18 client, verifies the custom-format archive
with `pg_restore --list`, and only then uploads it. Configure object-storage
lifecycle retention (at least 30 days) on the bucket; the workflow does not
delete old backups automatically.

After adding the secrets, run the workflow once with **Run workflow** and
restore the resulting archive into a disposable Neon branch. Record the
restore result in the project runbook before launch.

## Monitoring

- Keep `GET /api/health` as the uptime probe. It returns `200` only when the
  production database round-trip succeeds and never exposes connection data.
- Keep Vercel runtime logs enabled. `instrumentation.ts` emits request errors in
  one stable shape (`[request-error] ...`) so they can be searched and routed
  to an error provider later without changing handlers.
- Before launch, enable one Vercel observability provider (Vercel Web Analytics
  and Speed Insights, or an equivalent OpenTelemetry/Sentry destination) and
  verify that a deliberate staging error appears there. No provider is enabled
  by this repository because the choice and account credentials are external
  to the codebase.
- Check the health probe, recent error rate, database latency, and backup
  workflow status during the first week of the closed beta.

## Launch gate

The deployment is not ready to be public until object storage credentials,
Vercel production variables, a successful staging smoke test, the v4 question
gold set, and the monitoring/backup checks above are complete. Keep the
production cutover reminder open until those external checks are recorded.
