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
  sqlite3 "$S/t.db" "create table bank_run_ledger (status text, completed_at text);"
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
# Record one row so the stall clock starts, then hang forever.
CMD="sqlite3 $S/t.db \"insert into bank_run_ledger values('ok','2026-09-15 09:00:00');\"; sleep 300"
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
{ echo "begin;"; i=0; while [ $i -lt 40 ]; do echo "insert into bank_run_ledger values('failed','2026-09-15 09:0$((i%9)):00');"; i=$((i+1)); done; echo "commit;"; } | sqlite3 "$S/t.db"
LOG="$S/t.log" STATUS="$S/t.status" DB="$S/t.db" \
  REMAINING_CMD='echo 5' CHUNK_CMD='echo SHOULD_NOT_RUN' \
  BACKOFF_MIN=1 BACKOFF_MAX=1 \
  bash "$RUN" >/dev/null 2>&1 &
sup=$!
sleep 6; kill -TERM $sup 2>/dev/null; wait $sup 2>/dev/null
check "waited instead of running a chunk" "$(grep -c 'SHOULD_NOT_RUN' "$S/t.log")" "0"
check "said why it was waiting" "$([ "$(grep -c 'provider unhealthy' "$S/t.log")" -ge 1 ] && echo yes || echo no)" "yes"

echo
echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
