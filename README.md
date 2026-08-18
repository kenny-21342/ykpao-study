# YKPao Study

An integrated study platform for a single school cohort: past-paper practice, AI
tutoring and grading, collaborative notes, mock exams, and a discussion board.

Built with Next.js 16 (App Router), React 19, Prisma 7 on Postgres, NextAuth v4,
and Tailwind v4.

---

## Quick start

```bash
cp .env.example .env      # then fill in DATABASE_URL and NEXTAUTH_SECRET
npm install
npm run dev               # predev generates the Prisma clients, PDF worker, and service worker
```

The app boots at http://localhost:3000.

`DATABASE_URL` and `NEXTAUTH_SECRET` are **required** — the app throws at
startup rather than falling back to a localhost socket or an insecure default
signing key. See `.env.example` for the full list; every variable there is
documented with what breaks in its absence.

To reach the admin console, put your address in `ADMIN_EMAILS`.

### Database

```bash
npx prisma migrate deploy   # apply migrations
npx prisma studio           # browse data
```

The 29 historical migrations — 14 of which contained no `migration.sql` at all,
because the schema was evolved with `db push` — have been squashed into a single
baseline, `prisma/migrations/00000000000000_init/`. The originals are kept in
`prisma/migrations-legacy/`, which explains what was and wasn't carried over.

`migrate deploy` against an empty database has been verified to reproduce
`schema.prisma` exactly (69 tables), with full-text search working.

**On a database that already exists** — including the current dev database —
do *not* run `migrate deploy`; it would try to create tables that are already
there. Follow the adoption steps in `prisma/migrations-legacy/README.md`.

#### Known, intentional schema drift

`prisma migrate diff` reports four differences against any correctly-built
database:

```
[*] rag_chunks    [-] column `searchVector`, [-] 2 GIN indexes
[*] rag_documents [-] 1 GIN index
```

These are **not** drift to fix. `rag_chunks."searchVector"` is a
`GENERATED ALWAYS … STORED` tsvector, and the three indexes use
`gin_trgm_ops` — none of which `schema.prisma` can express, so Prisma sees them
as surplus and proposes dropping them. `lib/rag.ts` queries that column
directly, so dropping it breaks AI study search entirely.

They are created by hand at the bottom of the baseline migration. **Never run
`prisma migrate dev` or `prisma db push --accept-data-loss` without checking
what it plans to drop**, and re-append that block if the baseline is ever
regenerated.

---

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` / `npm run build` | Develop / production build (Turbopack) |
| `npm test` | Every suite — Node, personalization, catalogue, and the Python `bank`/`question_images` suites |
| `npm run lint` | ESLint over the app (Next 16 no longer lints during `build`) |
| `npm run sw:build` | Regenerates `public/sw.js` with a fresh cache version |
| `npm run icons:build` | Regenerates the PWA PNG icons from `public/icon.svg` |
| `npm run pdf:worker` | Copies the pdf.js worker into `public/` |
| `npm run papers:index` | Indexes the past-paper catalogue |
| `npm run rag:index` | Rebuilds the RAG index |

`predev` and `prebuild` run the Prisma, PDF-worker, and service-worker steps
automatically; you rarely need to invoke them by hand.

Tests require `python3` on `PATH` for the pipeline suites.

---

## Generated files — do not edit

- `public/sw.js` — generated from `scripts/sw-template.js`. Edit the template.
  The generator stamps in a per-build cache version; without it, returning users
  are served a previous build's HTML referencing deleted asset chunks.
- `public/pdf.worker.min.mjs` — copied from `node_modules`.
- `public/icon-*.png`, `public/apple-touch-icon.png` — generated from `icon.svg`.
- `generated/` — Prisma clients.

---

## Deployment notes

The target is Vercel (serverless).

### Function timeouts — configured for Vercel Hobby (60s)

Route handlers declare `maxDuration = 60`, Hobby's ceiling, because the platform
kills an invocation at its default limit regardless of what the request is
doing. Two consequences are worth knowing before you change anything:

**Mock exams are capped at 12 questions.** `lib/mock-exam-limits.ts` holds
`MAX_EXAM_ITEMS`, and grading runs `GRADING_CONCURRENCY = 4` LLM calls in
parallel — about 15–25s for a full paper, inside the limit. Generation
(`/api/mock-exams/generate` and `lib/predicted-paper.ts`) clamps to the *same*
constant, so an exam can never be created at a size that cannot be submitted.
That mattered: the model routinely returns more questions than the prompt asks
for, and `submit` used to silently `take:` the first N — a student answered
twenty questions, twelve came back graded, and eight vanished with nothing in
the UI to explain it.

**SSE streams last 50s**, then close cleanly and the client reconnects.

Moving to a plan with longer functions is a three-line change: raise
`MAX_EXAM_ITEMS`, raise `maxDuration` in the route handlers to match, and raise
`SSE_MAX_LIFETIME_MS`. Raising `MAX_EXAM_ITEMS` alone produces timeouts rather
than larger exams.

### Startup validation

`instrumentation.ts` calls `getEnv()` when the server boots, so a missing
`DATABASE_URL`, `NEXTAUTH_SECRET`, `ADMIN_EMAILS`, or storage configuration
fails immediately instead of one request at a time. It deliberately skips the
build phase (`NEXT_PHASE === 'phase-production-build'`), where a build machine
legitimately has none of those.

### Object storage

Bulk assets — past-paper PDFs (~17 GB), uploads, extracted diagrams, STEP
images — are read and written through `lib/storage/`, which has two drivers:

| `STORAGE_DRIVER` | Backend | Use |
|---|---|---|
| `local` (default) | Filesystem | Development, self-hosting with real disks |
| `s3` | Any S3-compatible bucket | Serverless (**required**) |

On a serverless host the filesystem is read-only, empty, and discarded between
invocations, so the local driver would 404 every past paper and every uploaded
image. `lib/env.ts` refuses to start a production deploy with `STORAGE_DRIVER`
unset; set `STORAGE_ALLOW_LOCAL_IN_PRODUCTION=true` to opt out on a box with
persistent disks.

The S3 driver signs its own requests (SigV4, `lib/storage/sigv4.ts`) rather than
depending on `@aws-sdk/client-s3`, which would add tens of megabytes to every
function bundle to perform a handful of HMACs. The implementation is pinned to
AWS's published `get-vanilla` test vector in `tests/sigv4.test.ts`.

**First deploy:** configure the variables in `.env.example`, then upload the
existing corpus from a machine that has it checked out:

```bash
npm run storage:sync -- --dry-run     # preview
npm run storage:sync                  # ~13,000 PDFs; expect this to take a while
```

The sync skips objects already present, so an interrupted run resumes cheaply.

**Bucket CORS.** Past papers are served by redirecting to a presigned URL, and
`react-pdf` fetches that URL with XHR. The bucket must therefore allow `GET`
from your app's origin, or the PDF viewer fails with an opaque CORS error while
the same URL opens fine in a new tab.

**URL shapes are unchanged.** `/uploads/**`, `/extracted_images/**` and
`/step-images/**` are still the public paths — they are recorded in thousands of
database rows and embedded in stored note HTML. They are now served by route
handlers (`app/uploads/[...path]/route.ts` and siblings) that resolve through
the object store. In development the static file under `public/` still wins, so
nothing changes locally.

> **Access control:** all three prefixes require an authenticated session,
> enforced by `serveProtectedAsset()` in `lib/storage/protected-asset.ts`
> before object storage is touched. Uploads contain student work, extracted
> images are crops of copyrighted past papers, and STEP images are worked
> solutions — none of that is public, and unguessable filenames are obscurity
> rather than a permission check. The gate reads the JWT session only (no
> database round trip), because one question page can pull dozens of diagrams;
> the consequence is that a banned user's unexpired token still resolves
> imagery, while every route that hands out *new* material still goes through
> `getSessionUser()`. A denial is `401` with `Cache-Control: no-store`, so no
> cache or service worker can retain it. The S3-backed handler then redirects
> an authenticated request to a short-lived signed URL; the local driver
> streams the object directly.

### Rate limiting

`lib/rate-limit.ts` is backed by Postgres (the `rate_limits` table), because the
previous in-memory `Map` was per-process: on serverless every invocation started
empty, so the login brute-force guard and the per-user AI spend caps silently
did nothing.

**Run `prisma migrate deploy` before deploying the code that uses it.** If the
table is missing the limiter logs a loud error and allows the request rather
than locking every user out — but until you migrate, limits are not enforced.

### Monitoring and backups

The root layout includes Vercel Web Analytics and Speed Insights. Enable both
for the Vercel project (the project settings are already enabled) so page views
and Web Vitals are collected after the first deployment. `GET /api/health` is
the unauthenticated uptime probe, and `instrumentation.ts` emits a consistent
`[request-error]` log record for server-side failures.

An independent nightly PostgreSQL backup workflow is ready at
`.github/workflows/neon-backup.yml`. It requires the direct production database
URL and private S3-compatible backup credentials as GitHub secrets. See
`docs/PRODUCTION_OPERATIONS.md` for the exact secret names, Neon snapshot
schedule, retention, and restore test required before launch.

### Realtime collaboration (SSE)

`lib/page-pubsub.ts` uses Postgres `LISTEN/NOTIFY`, which **does not work
through a transaction-mode connection pooler** (Neon `-pooler`, Supabase port
6543, any pgbouncer). LISTEN appears to succeed and then silently delivers
nothing — collaboration shows as connected and never updates.

- Set `DIRECT_DATABASE_URL` to the direct, unpooled connection string. The app
  warns at startup if the string it is given looks pooled.
- Set `SSE_MAX_LIFETIME_MS` a little *below* your platform's function timeout
  (default 240000) so the server closes streams cleanly instead of the platform
  killing them mid-flight.
- If a direct connection isn't available, set `COLLAB_REALTIME=off`. The
  endpoint then returns 501 and clients stop retrying after a few attempts;
  editing still works, it just doesn't show other people's cursors.

---

## Repository layout

```
app/                Next.js App Router — routes, API handlers, components
  api/              ~90 route handlers
  components/       Shared client components
  admin/            Admin console (gated by requireAdmin)
lib/                Server-side helpers: auth, prisma, ai, rate limiting, env
prisma/             Main schema + migrations
scripts/            Build steps, one-off migrations, indexing
tests/              Node (`*.test.ts`) and Python (`bank/`, `question_images/`) suites
docs/               Pipeline documentation
pdf_extraction/     Python extraction pipeline (not deployed)
```

## Security

`lib/auth.ts` is the single entry point for session handling: `getSessionUser()`
returns `null` for banned users, and `isModerator()` / `requireAdmin()` gate
elevated actions. Untrusted HTML — rich-text from students, markdown rendered by
`marked`, admin announcements — must go through `sanitizeHtml()` from
`lib/sanitize-html.ts` before reaching `dangerouslySetInnerHTML`.

The Content-Security-Policy in `next.config.ts` is intentionally
**Report-Only**: enforcing it requires per-request nonces from middleware, which
does not exist yet.
