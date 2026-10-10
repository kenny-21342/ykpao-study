# YKPao Study — development log

A past-paper study platform for IB and CAIE students, built between June and
September 2026. This document is a complete tour of what the site does, how it
is put together, and — in the second half — an honest account of the parts that
were genuinely hard.

---

## At a glance

| | |
|---|---|
| First commit | 6 June 2026 |
| Commits | 405 |
| Application code | ~57,500 lines across 294 TypeScript/TSX files |
| API routes | 91 |
| Database models | 82, across 23 hand-written migrations (a squashed baseline plus 22 since) |
| Test files | 69, 680 unit tests, plus a Playwright suite |
| Stack | Next.js 16 (App Router, Turbopack), React 19, Prisma 7, PostgreSQL (Neon), Vercel |
| Extraction pipeline | ~10,200 lines of Python |

**The corpus, in production today:**

| | |
|---|---|
| Questions in the crop-first bank | 70,045 (66,756 published) |
| …carrying machine-readable text | 65,572 |
| …with mark totals | 65,076 |
| Cropped question images | 129,786 |
| Papers | 14,193 |
| Subjects | 83 |
| Topics, and question→topic links | 539 / 87,995 |
| Mark schemes (with text) | 65,001 (64,079) |
| Legacy transcribed questions | 12,398 |
| Search index | 100,614 documents / 124,313 chunks |
| Grade boundary rows | 3,416 |

---

## The foundation: a crop-first question bank

Almost every feature on the site rests on one decision, made early and never
reversed: **a question is a picture of the original paper, not a transcription
of it.**

Past papers arrive as PDFs. The Python pipeline in `pdf_extraction/bank/`
downloads them, segments each page into individual questions, renders each
question as one or more PNG "strips", hashes the strips by content, and records
the question's position, paper, subject, session, year and paper number. A
student reading a question sees the real thing — the real diagram, the real
table, the real notation — because it *is* the real thing.

That choice is why the platform is usable at all for Physics and Maths, where a
transcription loses the figure the question is about. It is also the source of a
large fraction of the difficulties later in this document, because a picture
cannot be searched, graded, hinted at, or read aloud.

The resolution was to carry **both**: strips for the student, and a transcribed
`bodyMd` for every machine that needs words. Transcription is a separate, paid
vision-model pass. It now covers 65,572 of 66,756 published questions. Before it
ran, that number was zero, and every text-dependent feature was dark.

A second, older corpus of 12,398 fully transcribed questions predates the bank
and still serves some surfaces. The two have **separate ID sequences and are
never interchangeable** — a fact that caused real bugs and is now enforced in
the type system and asserted in tests.

---

## Features

### Accounts and getting started

- **Email/password and Google sign-in.** Credentials accounts must verify their
  address before the first sign-in; the gate sits *after* the password check, so
  it cannot be used to probe whether an account exists.
- **Verification, password reset and resend**, all on short-lived namespaced
  tokens, single-use.
- **Onboarding wizard** — pick your curriculum and subjects, set an exam date and
  weekly study minutes and per-day availability. Skipping is permanent, not a
  question you get asked again tomorrow.
- **A product tour** for new users: seven steps that spotlight each area of the
  shell, with Back/Next/Skip, shown once and then never again.
- **A first-run AI key card** that appears only if you have no working AI access,
  and stops for good once you do.
- **Terms and Privacy pages**, written from what the code actually does —
  including the disclosure that submitting an answer for marking sends it, and
  any photo of your working, to a third-party AI provider.

### Dashboard

The landing surface for a signed-in student: what is due today, subject
shortcuts, the daily challenge, a weakness heatmap, announcements, and the
notification bell. A signed-out visitor instead gets a server-rendered landing
page with real platform figures, crawlable, with Open Graph metadata, a robots
file and a sitemap.

### Practice — browsing and answering questions

- **Filter cascade**: subject → year → session → paper → topic. The options are
  *derived from the corpus*, not hardcoded, so the sessions and paper numbers you
  see are the ones that subject actually sat. The topic filter appears only once
  a subject is chosen, and lists only that subject's topics.
- **Scope switch**: My courses / All subjects / Starred.
- **Question view**: the real cropped question, a mark-scheme link where one
  exists, bookmarking.
- **Answering**: type an answer, or draw one.
- **Per-question scratchpad** — a pressure-sensitive drawing canvas with pen,
  eraser, colours, text boxes, undo/redo. Strokes are stored as vectors per
  attempt and **survive a reload mid-question**. At submit time a flattened image
  is attached to the attempt so the grader can see it.
- **Self-marking** for free-response questions: you award yourself a mark *out of
  the real total* against the mark scheme, not a binary right/wrong. On a 12-mark
  extended response, 7/12 and 0/12 are no longer the same row.
- **Progressive hints** — a nudge before the answer.
- **Daily challenge** — one question a day, state persisted.

### Study — the coaching layer

Six views behind one tab:

- **Today** — what is due, and the smallest next action.
- **Plan** — a study timetable generated *backwards from your exam date*, not
  forwards from today, weighted by topic mastery and your stated availability.
- **Mistakes** — a notebook of every question you got wrong, newest first, with
  your answer, the feedback, and a one-click "add to review".
- **Review** — spaced repetition over cards raised automatically from your
  mistakes. An SM-2-style scheduler with ease factors, intervals and lapses.
- **Cards** — the deck view.
- **Coverage** — a topic mastery heatmap, grouped by subject, showing what you
  have attempted, your accuracy, and what you have never touched.

Plus **command-term analytics**: the site knows the difference between a question
that says *evaluate* and one that says *describe*, because they are marked
against different criteria, and answering one as the other is the most common
avoidable way a prepared student loses marks. Your accuracy is broken down by
term.

### Mock exams

This is the most structurally ambitious feature.

- **Papers are assembled to match the shape of real ones.** The system measures
  actual past papers — how many questions, worth how many marks, in what order —
  and builds a blueprint per subject and paper number. That measurement is then
  *corrected against the exam board's own published totals*, because the
  extraction has gaps and 160 of 187 measured paper groups disagreed with the
  official total by more than a mark.
- **Generation is instant** for a plain mock — it is a database query over the
  bank, not a model call. Predicted papers use the AI path.
- **Sitting one**: a real timer, question navigation, mark-for-review, answers
  saved to the server continuously, survives a reload.
- **Grading**: multiple choice marks instantly from the stored answer key with no
  model involved. Free response goes to the AI, or falls back to self-marking if
  no AI is available — a student who has just sat a 90-minute paper never loses
  it.
- **Results**: per-question scores, the model answer, the original mark scheme,
  and a **target line** — how many marks short of your target grade you are, using
  the real grade boundaries for that subject.

### Past papers

The original PDFs, browsable by curriculum → subject → year → series → paper,
rendered in the browser's own native PDF viewer (so text search, zoom and the
outline panel all work), with a download link. Files are served through a
session-gated route that streams or signs a short-lived URL.

### Materials

- **Resource library** with a real folder tree — nested folders, breadcrumbs,
  rename, move (with a cycle guard), and delete that keeps the files. Folder
  uploads preserve the structure you dragged in.
- **Contributor attribution** on every file and folder.
- **Notes** — a rich text editor with Markdown input rules, LaTeX via KaTeX, live
  linting that squiggles broken math as you type, image upload and code blocks.
- Links out to the school's own resource site.

### Discussions

Threads with replies, voting, editing, flagging, labels, and admin pin/lock.
Deleted content genuinely stops being searchable.

### The AI layer

- **A tutor that can see your screen.** A serialiser describes what you are
  currently looking at — which question, which paper, how far through — and sends
  that with your message. It holds two rules that matter: a question with no
  transcript is declared *unreadable* rather than guessed at, and a paper still in
  progress carries an explicit instruction not to answer it.
- **Retrieval-augmented answers** over the whole corpus — questions, mark schemes,
  notes, resources, announcements and discussions — using PostgreSQL trigram
  similarity and full-text search rather than a vector database.
- **Plan detection**: when the tutor's reply is shaped like a study plan, a
  "Schedule this plan" button appears, parses the steps, and offers them as an
  editable draft of real scheduled tasks. Nothing is applied until you confirm.
- **Grading**, text and vision — a drawn or photographed answer goes to a
  vision-capable model with the question and mark scheme, not to an OCR pass that
  throws the diagram away.
- **Handwriting OCR**, progressive hints, exam generation, and on-demand
  transcription of untranscribed questions.
- **Bring your own key.** Students use their own AI provider account — DeepSeek,
  SiliconFlow, OpenRouter or a school proxy. Keys are encrypted at rest and never
  displayed again. Administrators can grant shared access instead. Everything
  except AI works with no key at all, and every AI-off message is a link to the
  page that fixes it.
- **Usage and cost accounting** per feature and per day, visible to the student.

### Search

A ⌘K palette across every content type, scoped so it can never surface another
user's private material, with typed result badges and deep links.

### Target grades

Set a target per subject in settings. It resolves through the real grade
boundary table into a mark threshold, and then drives the mock-exam target line
and an on-track / at-risk chip. Where there is not enough evidence to judge, it
says so — "sit a mock exam to see if you are on track" — rather than inventing a
verdict.

### Notifications and announcements

Server-sent events for live notification delivery, an unread badge, mark-read,
and admin-authored announcements with severity and audience targeting.

### Admin console

Eight sections: dashboard KPIs, user management (search, roles, ban/unban), AI
access granting, content moderation, announcements, resource management, a bank
review queue for badly-cropped questions, and a system monitor showing cost by
model and feature, error rates and the largest files.

### The rest of the shell

Dark and light themes on a proper design token layer, an installable PWA with an
offline app shell, a component style guide at `/admin/styleguide`, keyboard
focus management and ARIA labelling throughout, and a mobile layout that works
at 390px.

And a Konami-code easter egg that unlocks a competition question vault.

---

## What was hard

### 1. A picture is not a question

The crop-first decision was right and I would make it again, but it meant that
for months the corpus was *invisible to software*. Search could not index it. The
tutor could not discuss it. The grader marked free-response answers against an
empty string — and produced **confident zeros**, complete with a fluent
explanation of why the student's answer was wrong, having never seen the
question. That was the single worst bug in the project's history, because it was
wrong in the most convincing possible way.

The fix had three parts: gate vision grading off entirely when there is no
question text (an honest "ungraded" is better than a confident zero), build an
on-demand transcription path, and then run a bulk transcription pass over the
whole corpus. That pass cost real money and days of wall-clock time, and it had
a trap in it — see below.

### 2. The pusher that reported success and wrote nothing

The Python merge script was **insert-only**: `ON CONFLICT DO NOTHING`, plus an
explicit skip for any question already present. Every question was already
present. So a full transcription run would have completed, cost the full amount,
printed a success line, and landed **absolutely nothing**.

This was caught before the big run, but only because the same trap had already
been hit once with mark totals and documented in a comment at the top of the
script that fixed it. Writing that comment was worth more than the code under
it.

### 3. One character, 7,677 missing answer keys

Production held zero answer keys for 9,408 published IB Paper 1 questions —
every one of them multiple choice, every answer sitting in a mark scheme already
on disk.

The cause was that the detector required the question number to be a bare
integer, and the IB writes `1.` with a trailing period where CAIE writes `1`. Not
a partial failure: **zero of 221 papers**.

The cost was not subtle. Whether a paper is multiple choice is inferred from the
share of its questions carrying a key, so IB Paper 1 measured as *structured*.
A generated IB Physics Paper 1 was therefore forty multiple-choice questions sent
one at a time to a vision model to be marked against no mark scheme — slow, paid
for, and wrong. With the keys landed, the same paper marks itself in the request
with no model at all.

### 4. IB mark schemes that were there all along

A large share of IB questions appeared to have no mark scheme. The instinct was
that the data was missing. It was not: the mark schemes were on disk and in the
database, but unlinked, because the IB's file naming does not match the pattern
the linker expected. Proving it was a *merge gap* rather than missing data took
longer than writing the fix. Coverage went from 59.7% to 80.9% in one insert-only,
`NOT EXISTS`-guarded pass.

The lesson that generalised: **before building anything to produce missing data,
prove the data is actually missing.**

### 5. The answer key in the network tab

The mock-exam route returned `answerLetter` on every item regardless of the
exam's status. A student sitting a paper could read the correct letter for every
multiple-choice question straight out of the browser's network tab. The mark
scheme — the worked answer to the question in front of them — went the same way.

Both are now withheld until submission. In their place the client gets just
enough to draw the option buttons. An unglamorous bug, and the one with the worst
consequences if it had reached a whole year group.

### 6. Database connections, and why one user took the site down

Mid-sweep, with exactly one person signed in and nothing else running, the
dashboard reported that progress could not be loaded and two routes started
answering 503.

It was not load. `idle_session_timeout` was 120 seconds, so every warm serverless
instance parked its connection pool for two minutes after its last query. Nine of
seventeen usable slots were held, every one idle, the oldest 75 seconds — three
instances times a pool of three. Eight remained held minutes later while the
browser sat on an error page.

Serverless plus connection-limited Postgres is a genuinely awkward pairing, and
this took a migration off the original provider (a hard ceiling of 20 connections,
about 8 of them taken by the provider itself) onto one with real pooling, plus
app-side pool tuning, plus dropping the idle timeout to 30 seconds.

### 7. Search that was slow for a reason no index could fix

Every slow search turned out to be the same shape: an `OR` spanning two joined
tables. PostgreSQL cannot use an index for that — it degrades to a scan no matter
what you add. The fix was never a new index; it was splitting the query into
separate arms and unioning the results. Two further traps in the same area:
`similarity()` cannot use an index either (`word_similarity` with the `<%`
operator can), and running it across 124,000 chunks is expensive enough to
matter.

### 8. Testing against real input, not invented input

The study-plan detector passed every fixture I wrote for it and then returned
`false` on the very first real model response. My fixtures all used `- ` bullets;
the real output numbered its steps as Markdown headings. Two more real-world
cases followed immediately.

All three are now pinned as tests built from *captured* output. This is the
habit I would most want to keep: **a fixture you invented tests your imagination,
not the system.**

### 9. A rate limit that would have locked out a whole class

Signup and login were both throttled at 5 requests per minute per IP. A year
group shares one school NAT address. The sixth student to sign in at the start of
a lesson would have been locked out, told to wait a minute, and then stayed
locked out because their classmates kept spending the budget as fast as it
refilled.

Split into a generous per-IP limit sized for a class and a tight *per-account*
limit, which is the control that actually stops password spraying. Found by
thinking about the deployment environment rather than by any test.

### 10. A first-run card that could never have appeared

The card prompting new students to set up an AI key read `textEnabled` off the
wrong level of the response envelope. Because the check was the conservative
`=== false`, `undefined` never matched, and the card **could never have rendered
for anybody** since the day it shipped. Defensive comparisons can hide a bug
instead of surviving one.

### 11. Scoping that quietly deleted your history

Found on the last day. The mistake notebook was scoped to the subjects you are
enrolled in *today*, and the client had no way to widen it — so 40 real mistakes
were unreachable, while the coverage heatmap on the same page cheerfully listed
the topics of those very attempts, because it had never been scoped at all. Two
views of one history, disagreeing.

Worse, the "add to review" button looked broken for the same reason: the POST
always worked, but the lookup deciding whether to show "Add review" or "In
review" was scoped by subject *name*, which never matched. Every press silently
wrote a card the student could never see, and 131 of 135 cards were missing from
the review queue.

The principle that came out of it: **history is not a catalogue.** What you did
last term does not stop having happened because you dropped the subject.

### 12. A green CI that was hiding a red one

The nightly end-to-end run had failed every night for a day and nobody looked —
because the only way to re-run it by hand was also the way that left test folders
in the live resource library that only an administrator could delete. The safe
move was to do nothing, so nothing is what happened.

The failure itself was harmless (specs left behind by a removed feature), but the
structural problem was not: **a gate nobody can safely re-run is not a gate.**
The manual trigger now takes an explicit checkbox that defaults to off.

### 13. Things that only break in production

A short list of bugs that no amount of local testing would have found: the
Postgres driver shifting error timestamps by eight hours, so incidents read as
eight hours older than they were. A doubled bucket name that lived in a CI
secret rather than in any file in the repository. A startup parameter the
connection pooler refuses. An uptime probe that was paying to keep the database
awake. And verification email that lands in Gmail's Junk folder for reasons that
are not fixable with DNS — SPF, DKIM and DMARC are all correct; what is wrong is
that a brand-new domain with no sending history, pairing a school's name with an
unrelated-sounding domain, looks exactly like phishing to a spam filter.

---

## Things deliberately not built

Worth recording, because restraint is a design decision too:

- **Real-time collaborative editing (CRDT).** Completely built, tested, and left
  switched off. PostgreSQL `NOTIFY` payloads cap at 8KB and CRDT updates exceed
  that easily, so the transport had to be redesigned around it. It works, but
  turning it on needs concurrent-editing verification that there was no time for,
  and shipping it half-wired is the one change here that could silently corrupt a
  document.
- **A notebook workspace.** Built, then removed on the judgement that nobody would
  use it. Backed up to a tag, a branch, a row-level export and a source archive
  before deletion — which is the only reason removing it was a decision rather
  than a gamble.
- **Vector embeddings for search.** Trigram plus full-text is good enough at this
  corpus size and needs no extra infrastructure.
- **A global AI spend ceiling.** A deliberate choice, not an oversight.
- **Target-aware question difficulty.** The `difficulty` column is too skewed to
  be trustworthy yet.

---

## How it is tested

680 unit tests across 69 files, run under plain Node with no framework. A
Playwright suite against the real production deployment as a real student,
nightly. Type checking, linting and a full build on every push.

Two testing habits that earned their place:

1. **Tests that read the source.** Several tests scan every file under `app/` for
   patterns that must never come back — a bare `confirm()`, an icon-only button
   with no accessible name, a fetch that unwraps the wrong envelope level. They
   catch a class of regression rather than an instance.
2. **Prove the test fails first.** Every regression test in this project was
   confirmed to fail against the bug before being kept. A test that has never been
   red is a test you are trusting on faith.

---

## If I started again

- Decide the picture-versus-text question on day one and carry **both** from the
  beginning. Retrofitting text into an image-only corpus touched nearly every
  feature.
- Write the column-updating pusher before the batch job that fills it.
- Put the deployment environment in the threat model early. The shared-NAT rate
  limit and the connection ceiling were both predictable from facts known at the
  start.
- Capture real input for fixtures from the first day a real model response
  exists.
- Never let a scheduled check be red for a day. Either fix it or delete it.

---

*Built June–September 2026.*
