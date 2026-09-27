# Production operations

This is the handoff checklist for the first online deployment. It deliberately
keeps secrets out of the repository; values belong in Vercel and GitHub Actions
secret stores.

## Database recovery

Production runs on Aiven for PostgreSQL. Both Neon projects were deleted on
26 Sep 2026, so nothing below depends on Neon any more; confirm Aiven's own
backup retention on the service's **Backups** tab with the project owner.

For an independent copy that survives losing the provider account, the
repository includes a nightly
GitHub Actions workflow at `.github/workflows/db-backup.yml`. Add these
repository secrets before enabling it:

| Secret | Value |
| --- | --- |
| `BACKUP_DATABASE_URL` | The unpooled production connection string (never a `-pooler` host). Set this when the database moves provider. The old `NEON_DIRECT_DATABASE_URL` fallback was removed on 26 Sep 2026 and the secret deleted — a missing value now fails loudly instead of silently |
| `RESTORE_TARGET_DATABASE_URL` | Where `db-restore.yml` writes. Must not be the backup source unless `confirm=RESTORE-OVER-LIVE` |
| `BACKUP_S3_BUCKET` | A private S3-compatible backup bucket |
| `BACKUP_S3_ACCESS_KEY_ID` | Write credential for that bucket |
| `BACKUP_S3_SECRET_ACCESS_KEY` | Matching secret key |
| `BACKUP_S3_REGION` | Bucket region (`us-east-2`, `auto`, etc.) |
| `BACKUP_S3_ENDPOINT` | Optional endpoint for Neon Object Storage/R2/MinIO; leave blank for AWS S3 |

Two optional repository variables: `BACKUP_S3_PREFIX` defaults to `postgres`,
and `BACKUP_RETENTION_DAYS` defaults to **90**, matching the window `/privacy`
promises students. The workflow refuses any value under 30.

The workflow uses a PostgreSQL 18 client, verifies the custom-format archive
with `pg_restore --list`, uploads it, and then deletes dumps past the
retention window. It deletes only keys it wrote itself (`<prefix>/ykpao-study-*.dump`)
and always keeps the seven most recent whatever their age, so a workflow that
was paused for longer than the window cannot expire the entire history on the
run that resumes it. Each run prints what it removed to the job summary.

Until 27 Sep 2026 this section instead asked for a bucket lifecycle rule to be
configured by hand, and it never was — so every dump ever taken was kept
indefinitely and the 90-day sentence in `/privacy` was untrue. **A bucket
lifecycle rule is still worth adding as a backstop**, because it holds even
when the workflow does not run: in the Cloudflare dashboard, R2 → the backup
bucket → Settings → Object lifecycle rules → add a rule scoped to the
`postgres/` prefix that deletes objects 90 days after upload. Set it to the
same number as `BACKUP_RETENTION_DAYS`, or the two will disagree about what
the policy says.

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

## Question bank review

The admin console has a **Bank Review** queue. It shows QA flags, question and
mark scheme crops, transcription text, and the source PDF. Reviewers can resolve
or dismiss a flag, or inspect held questions without blocking flags, then
explicitly publish a question. Publishing requires a
source crop and no open high or medium flags on that question or its paper.
The reviewer and time are recorded in Postgres. Mark schemes remain separate:
publishing a question does not publish its mark scheme.

Apply `20260923150000_deduplicate_bank_review_flags` before the next
`merge_to_neon.py` run. The migration preserves an existing review decision
when it removes duplicate flags, and its unique index makes later imports
idempotent. Merges now include held questions and mark schemes for the admin
queue; student-facing queries still require `status='published'`. Use
`--published-only` only when an intentionally incomplete review queue is
acceptable. Admin decisions live in Postgres; the ongoing SQLite extraction
store is not modified by review actions.

## Launch gate

The deployment is not ready to be public until object storage credentials,
Vercel production variables, a successful staging smoke test, the v4 question
gold set, and the monitoring/backup checks above are complete. Keep the
production cutover reminder open until those external checks are recorded.
