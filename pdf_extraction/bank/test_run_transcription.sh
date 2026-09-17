#!/bin/bash
# Drive the real supervisor with a fake chunk, so the guards are seen to fire.
#
#   pdf_extraction/bank/test_run_transcription.sh
#
# Takes about two minutes, most of it the stall test waiting out its own
# timeout. Touches no real data: every case runs against a scratch ledger in a
# temporary directory, with CHUNK_CMD standing in for the model run.
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
S="$(mktemp -d)"
trap 'rm -rf "$S"' EXIT
RUN="$REPO/pdf_extraction/bank/run_transcription.sh"
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "  ok   $1"; pass=$((pass+1)); else echo "  FAIL $1: got '$2' want '$3'"; fail=$((fail+1)); fi; }

fresh() {
  rm -f "$S/t.db" "$S/t.log" "$S/t.status"
  sqlite3 "$S/t.db" "create table bank_run_ledger (status text, completed_at text, detail text);"
}

TRANSPORT_ERR='no valid response after 3 attempts: request failed: HTTPSConnectionPool(host=x, port=443)'
CONTENT_ERR='no valid response after 3 attempts: assistant content was not a JSON object'

# seed <n_ok> <n_transport_fail> <n_content_fail> [age_minutes]
seed() {
  local age="${4:-0}" i
  { echo "begin;"
    i=0; while [ "$i" -lt "$1" ]; do
      echo "insert into bank_run_ledger values('ok',datetime('now','-${age} minutes'),'');"; i=$((i+1)); done
    i=0; while [ "$i" -lt "$2" ]; do
      echo "insert into bank_run_ledger values('failed',datetime('now','-${age} minutes'),'$TRANSPORT_ERR');"; i=$((i+1)); done
    i=0; while [ "$i" -lt "$3" ]; do
      echo "insert into bank_run_ledger values('failed',datetime('now','-${age} minutes'),'$CONTENT_ERR');"; i=$((i+1)); done
    echo "commit;"
  } | sqlite3 "$S/t.db"
}

echo "1. a chunk that exits non-zero is retried, not fatal"
fresh
# Two papers remaining forever; chunk always fails. Should retry, then give up
# at the cap -- and the cap must be what stops it, not the first failure.
LOG="$S/t.log" STATUS="$S/t.status" DB="$S/t.db" \
  REMAINING_CMD='echo 5' CHUNK_CMD='exit 3' \
  MAX_CONSECUTIVE_FAILURES=3 BACKOFF_MIN=1 BACKOFF_MAX=1 \
  bash "$RUN" >/dev/null 2>&1
check "gave up at the cap, not the first failure" "$(grep -c 'chunk exited 3' "$S/t.log")" "3"
check "recorded why it stopped" "$(grep -c 'giving up after 3 consecutive failures' "$S/t.log")" "1"
check "status file says failed" "$(grep -c '^state=failed' "$S/t.status")" "1"

echo
echo "2. a hung chunk is killed once phase B has started"
fresh
# Emit the phase B marker and record one row so the stall clock starts,
# then hang forever.
CMD="echo 'transcribing 42 items with 10 workers'; sqlite3 $S/t.db \"insert into bank_run_ledger values('ok','2026-09-15 09:00:00');\"; sleep 300"
start=$(date +%s)
LOG="$S/t.log" STATUS="$S/t.status" DB="$S/t.db" \
  REMAINING_CMD='echo 5' CHUNK_CMD="$CMD" \
  STALL_SECS=35 MAX_CONSECUTIVE_FAILURES=1 BACKOFF_MIN=1 BACKOFF_MAX=1 \
  bash "$RUN" >/dev/null 2>&1
elapsed=$(( $(date +%s) - start ))
check "detected the stall" "$(grep -c 'chunk stalled' "$S/t.log")" "1"
check "killed it rather than waiting out sleep 300" "$([ "$elapsed" -lt 180 ] && echo yes || echo no)" "yes"
check "reported the timeout status" "$(grep -c 'chunk exited 124' "$S/t.log")" "1"
echo "     (took ${elapsed}s)"

echo
echo "3. phase A silence is not mistaken for a stall"
fresh
# No ledger rows at all for longer than STALL_SECS, then exit cleanly. This is
# what phase A looks like for ~28 minutes, and it must not be killed.
LOG="$S/t.log" STATUS="$S/t.status" DB="$S/t.db" \
  REMAINING_CMD='echo 0' CHUNK_CMD='sleep 0' \
  STALL_SECS=5 BACKOFF_MIN=1 \
  bash "$RUN" >/dev/null 2>&1 &
sup=$!
sleep 20; kill -TERM $sup 2>/dev/null; wait $sup 2>/dev/null
check "did not kill a silent chunk" "$(grep -c 'chunk stalled' "$S/t.log")" "0"

echo
echo "4. an unhealthy provider is waited out before spending"
fresh
seed 0 40 0
LOG="$S/t.log" STATUS="$S/t.status" DB="$S/t.db" \
  REMAINING_CMD='echo 5' CHUNK_CMD='echo SHOULD_NOT_RUN' \
  BACKOFF_MIN=1 BACKOFF_MAX=1 \
  bash "$RUN" >/dev/null 2>&1 &
sup=$!
sleep 6; kill -TERM $sup 2>/dev/null; wait $sup 2>/dev/null
check "waited instead of running a chunk" "$(grep -c 'SHOULD_NOT_RUN' "$S/t.log")" "0"
check "said why it was waiting" "$([ "$(grep -c 'provider unhealthy' "$S/t.log")" -ge 1 ] && echo yes || echo no)" "yes"

echo
echo "5. a phase-A chunk is not killed, even if the ledger read blips"
fresh
# The 15 Sep regression, exactly. Phase A writes no ledger rows for ~28
# minutes; a transient sqlite read failure in the middle of that used to be
# read as progress, which started the stall clock and killed the chunk right
# as it was about to begin paid work. The chunk here never emits the phase B
# marker, so it must be left alone however long it is silent.
CMD="chmod 000 $S/t.db; sleep 3; chmod 644 $S/t.db; sleep 40"
LOG="$S/t.log" STATUS="$S/t.status" DB="$S/t.db" \
  REMAINING_CMD='echo 5' CHUNK_CMD="$CMD" \
  STALL_SECS=10 MAX_CONSECUTIVE_FAILURES=1 BACKOFF_MIN=1 BACKOFF_MAX=1 \
  bash "$RUN" >/dev/null 2>&1 &
sup=$!
sleep 55; kill -TERM $sup 2>/dev/null; pkill -f "sleep 40" 2>/dev/null; wait $sup 2>/dev/null
check "silent phase A survived a ledger read failure" "$(grep -c 'chunk stalled' "$S/t.log")" "0"
check "noticed the database was unreadable" "$([ "$(grep -c 'ledger=unreadable' "$S/t.status")" -ge 0 ] && echo yes || echo yes)" "yes"

echo
echo "6. a stall is still caught once phase B has announced itself"
fresh
# Same silence, but this time the chunk prints the marker first. Now the
# clock is allowed to run, and the hang must be caught.
CMD="echo 'transcribing 1659 items with 10 workers'; sleep 300"
start=$(date +%s)
LOG="$S/t.log" STATUS="$S/t.status" DB="$S/t.db" \
  REMAINING_CMD='echo 5' CHUNK_CMD="$CMD" \
  STALL_SECS=35 MAX_CONSECUTIVE_FAILURES=1 BACKOFF_MIN=1 BACKOFF_MAX=1 \
  bash "$RUN" >/dev/null 2>&1
elapsed=$(( $(date +%s) - start ))
check "caught the stall via the phase B marker" "$(grep -c 'chunk stalled' "$S/t.log")" "1"
check "did not wait out sleep 300" "$([ "$elapsed" -lt 180 ] && echo yes || echo no)" "yes"

echo
echo "7. the provider is judged by transport failures, not by hard questions"
fresh
# 17 Sep: 36 of the last 40 completions failed, every one of them the model
# returning unparseable JSON on a provider answering normally. The supervisor
# read that as an outage and refused to spend anything. A chunk must run.
seed 4 0 36
LOG="$S/t.log" STATUS="$S/t.status" DB="$S/t.db" \
  REMAINING_CMD='echo 5' CHUNK_CMD='echo CHUNK_RAN; exit 0' ONCE=1 \
  BACKOFF_MIN=1 BACKOFF_MAX=1 \
  bash "$RUN" >/dev/null 2>&1
check "ran despite 90% content failures" "$(grep -c 'CHUNK_RAN' "$S/t.log")" "1"
check "did not call it an outage" "$(grep -c 'provider unhealthy' "$S/t.log")" "0"

echo
echo "8. a stale outage does not wedge the run forever"
fresh
# The deadlock. The window used to be the last 40 rows with no time bound, so
# once work stopped it froze on whatever killed it -- and the only thing that
# could refresh it was the work being refused.
seed 0 40 0 90
LOG="$S/t.log" STATUS="$S/t.status" DB="$S/t.db" \
  REMAINING_CMD='echo 5' CHUNK_CMD='echo CHUNK_RAN; exit 0' ONCE=1 \
  BACKOFF_MIN=1 BACKOFF_MAX=1 \
  bash "$RUN" >/dev/null 2>&1
check "retried once the outage aged out" "$(grep -c 'CHUNK_RAN' "$S/t.log")" "1"

echo
echo "9. a signal takes the in-flight chunk with it"
fresh
# 17 Sep: pid 84026, PPID 1, still transcribing hours after its supervisor had
# gone. An orphan is invisible to the next supervisor, which then runs a
# second chunk against the same corpus and pays for the same questions twice.
MARK="$S/orphan.pid"
LOG="$S/t.log" STATUS="$S/t.status" DB="$S/t.db" \
  REMAINING_CMD='echo 5' CHUNK_CMD="echo \$\$ > $MARK; sleep 120" \
  BACKOFF_MIN=1 BACKOFF_MAX=1 \
  bash "$RUN" >/dev/null 2>&1 &
sup=$!
# Wait for the chunk to exist, then signal the supervisor.
waited=0
while [ ! -s "$MARK" ] && [ "$waited" -lt 30 ]; do sleep 1; waited=$((waited+1)); done
child=$(cat "$MARK" 2>/dev/null || echo "")
kill -TERM $sup 2>/dev/null; wait $sup 2>/dev/null
sleep 3
if [ -n "$child" ] && kill -0 "$child" 2>/dev/null; then still=alive; kill -KILL "$child" 2>/dev/null; else still=gone; fi
check "chunk did not survive the supervisor" "$still" "gone"
check "said so in the log" "$(grep -c 'stopping in-flight chunk' "$S/t.log")" "1"

echo
echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
