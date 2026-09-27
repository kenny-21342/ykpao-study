#!/usr/bin/env bash
#
# Wait for the tagging run to finish, then land the multiple-choice answer keys.
#
# WHY A WATCHER. Both steps below write, and `tag_corpus --apply` holds
# extract.db for hours at a time. Running them concurrently risks contending
# with work that has already been paid for, so the only safe moment is the one
# right after tagging exits -- which is otherwise a moment nobody is awake for.
#
#   1. answer_keys.py --apply    local, additive; fills the keys the old
#                                detector skipped (7,677 across 221 papers)
#   2. apply-answer-keys.mjs     production; verify first, then --apply
#
# Step 2 is a write to the live corpus, and it runs unattended, so it is
# guarded rather than trusted: the verify pass must report a plausible number
# of resolvable keys before the apply is allowed to run. Both steps are
# additive and idempotent -- the local pass only inserts missing rows and only
# sets `answer_letter` where NULL, and the pusher fills keys solely where there
# is none -- so the worst case of a re-run is that it writes nothing.
#
#   nohup scripts/watch-tagging-then-answer-keys.sh > /dev/null 2>&1 &
#
# Progress and every command's output go to the log below.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

LOG="pdf_extraction/bank/answer-keys-watch.log"
MIN_RESOLVABLE=3000   # 3,292 are resolvable today; the backfill should raise it

say() { printf '%s  %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >> "$LOG"; }

say "watcher started; waiting for tag_corpus to exit"

# Poll rather than `wait`: the tagging run is not our child, and it may be
# relaunched by hand, so this waits for the last one to go rather than a pid.
while pgrep -f "pdf_extraction.bank.tag_corpus" > /dev/null 2>&1; do
  sleep 60
done
say "tag_corpus has exited"

# A stale WAL means a writer died mid-transaction, or another pass is running
# that pgrep did not name. Give SQLite a moment to settle either way.
sleep 30
for other in corpus_run run_transcription marks.py; do
  if pgrep -f "$other" > /dev/null 2>&1; then
    say "ABORT: $other is still writing extract.db; nothing was run"
    exit 1
  fi
done

say "step 1/2: answer_keys.py --apply (local store)"
python3 -m pdf_extraction.bank.answer_keys --apply >> "$LOG" 2>&1
if [ $? -ne 0 ]; then
  say "ABORT: the local backfill failed; production was not touched"
  exit 1
fi

say "step 2/2: apply-answer-keys.mjs (verify)"
VERIFY=$(node --experimental-strip-types -r dotenv/config scripts/apply-answer-keys.mjs --board IB 2>&1)
printf '%s\n' "$VERIFY" >> "$LOG"

# "  resolvable in production:      7,612"
COUNT=$(printf '%s' "$VERIFY" | sed -n 's/.*resolvable in production: *\([0-9,]*\).*/\1/p' | tr -d ',')
if [ -z "$COUNT" ] || [ "$COUNT" -lt "$MIN_RESOLVABLE" ]; then
  say "ABORT: verify reported '${COUNT:-nothing}' resolvable, below the $MIN_RESOLVABLE floor."
  say "       Nothing was written. Inspect the verify output above and run --apply by hand."
  exit 1
fi
say "verify reports $COUNT resolvable keys; applying"

node --experimental-strip-types -r dotenv/config scripts/apply-answer-keys.mjs --board IB --apply >> "$LOG" 2>&1
if [ $? -ne 0 ]; then
  say "FAILED: the push errored. The script is idempotent, so a re-run is safe."
  exit 1
fi

say "DONE: answer keys are in production. IB Paper 1 mocks now mark themselves."
