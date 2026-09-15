#!/bin/bash
# Drive the corpus transcription in bounded chunks, and keep it alive.
#
# One process for all 14,193 papers spends about nine hours in phase A --
# re-segmenting and re-rendering every paper -- before the first model call,
# and holds a rendered span for each of ~138,000 items while it does. Chunks
# keep both bounded, and each one that finishes is progress the next skips,
# because a model run now resumes on the ledger.
#
# Safe to stop at any point: the ledger is per question, so nothing already
# paid for is paid for twice.
#
#   pdf_extraction/bank/run_transcription.sh           # until done
#   CHUNK=100 pdf_extraction/bank/run_transcription.sh # smaller chunks
#   ONCE=1    pdf_extraction/bank/run_transcription.sh # a single chunk
#
# Run it detached so it outlives the shell that started it. macOS has no
# setsid, and `nohup ... &` only ignores SIGHUP -- it does not survive the
# process group being torn down, which is how the 15 Sep run died. For a
# multi-day batch use the launchd agent, which restarts it if it is killed:
#
#   cp pdf_extraction/bank/bond.busypizza.transcription.plist \
#      ~/Library/LaunchAgents/
#   launchctl load ~/Library/LaunchAgents/bond.busypizza.transcription.plist
#   launchctl list | grep transcription      # check it is up
#   launchctl unload ~/Library/LaunchAgents/bond.busypizza.transcription.plist
#
# For an attended run in a terminal, plain `./run_transcription.sh` is fine.
#
# NOTE: bash reads a script incrementally, by byte offset. Editing this file
# while a run is in flight can make the running copy jump into the middle of a
# line. Stop the run before editing it.
#
# WHY THIS SUPERVISES RATHER THAN JUST LOOPING
#
# On 15 Sep a healthy run (10-12 questions/minute) hit two minutes of
# connection failures to the provider, burned its retries marking 47 questions
# `failed`, and the whole process group then died without writing its exit
# line. Nothing noticed. The same thing had already cost twelve days between
# 1 and 13 Sep. Three separate faults, so three separate guards:
#
#   1. A chunk that exits non-zero no longer stops the run. It backs off and
#      retries, because the usual cause is a provider blip, and stopping turns
#      a five-minute outage into however long until someone looks.
#   2. A chunk can "succeed" while the provider is broken -- every question
#      fails, each failure is recorded, the exit code is 0. So health is read
#      from the ledger, not the exit code, and a bad stretch backs off instead
#      of grinding the remaining corpus into `failed` rows at full speed.
#   3. A chunk that stops making progress is killed and retried, which is the
#      case no exit code can report at all.
set -u
cd "$(dirname "$0")/../.."

CHUNK="${CHUNK:-300}"
SPEND="${SPEND:-120}"
CONCURRENCY="${CONCURRENCY:-10}"
ONCE="${ONCE:-0}"
# A chunk that has recorded nothing for this long is not working. Generous,
# because phase A is silent for ~28 minutes at CHUNK=300 and a slow provider
# is not the same as a stuck one -- the stall clock only starts once phase B
# has recorded its first row.
STALL_SECS="${STALL_SECS:-1800}"
# Of the most recent completions, the failure percentage at or above which the
# provider is treated as unhealthy. An integer, so the comparison is a shell
# test rather than a dependency on bc being installed.
UNHEALTHY_PCT="${UNHEALTHY_PCT:-60}"
BACKOFF_MIN="${BACKOFF_MIN:-60}"
BACKOFF_MAX="${BACKOFF_MAX:-1800}"
MAX_CONSECUTIVE_FAILURES="${MAX_CONSECUTIVE_FAILURES:-8}"

LOG="${LOG:-pdf_extraction/bank/transcription-run.log}"
STATUS="${STATUS:-pdf_extraction/bank/transcription-status.txt}"
DB="${DB:-pdf_extraction/bank/extract.db}"
# Overridable so the guards can be exercised against a fake chunk that fails,
# hangs, or succeeds on demand. An unattended process that has never been
# watched failing is not a supervisor, it is a hope.
CHUNK_CMD="${CHUNK_CMD:-}"
REMAINING_CMD="${REMAINING_CMD:-}"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$LOG"; }

# A file anyone (or anything) can stat to see whether this is alive, without
# having to parse the log or guess from the process table.
status() {
  printf '%s\npid=%s\nstate=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$$" "$*" > "$STATUS"
}

ledger_count() {
  sqlite3 "file:${DB}?mode=ro" 'select count(*) from bank_run_ledger;' 2>/dev/null || echo 0
}

# Failure share over the most recent completions. Printed as a percentage so
# the shell can compare it without needing floating point.
recent_failure_pct() {
  sqlite3 "file:${DB}?mode=ro" \
    "select cast(round(100.0 * sum(case when status='failed' then 1 else 0 end) / count(*)) as int)
       from (select status from bank_run_ledger order by completed_at desc limit 40);" 2>/dev/null || echo 0
}

papers_remaining() {
  if [ -n "$REMAINING_CMD" ]; then eval "$REMAINING_CMD"; return; fi
  python3 - <<'PY' 2>/dev/null || echo -1
import sys
sys.path.insert(0, ".")
from pdf_extraction.bank.corpus_run import collect, transcribed
done = transcribed()
print(sum(1 for p in collect() if str(p) not in done))
PY
}

# Run one chunk under a stall watchdog. Returns the chunk's exit status, or
# 124 if it had to be killed for making no progress.
run_chunk() {
  if [ -n "$CHUNK_CMD" ]; then
    eval "$CHUNK_CMD" >> "$LOG" 2>&1 &
  else
  python3 -m pdf_extraction.bank.corpus_run \
      --use-model --no-tagging \
      --chunk "$CHUNK" --concurrency "$CONCURRENCY" --max-spend "$SPEND" >> "$LOG" 2>&1 &
  fi
  local pid=$!
  local last_count last_progress now started_phase_b=0
  last_count=$(ledger_count)
  last_progress=$(date +%s)

  while kill -0 "$pid" 2>/dev/null; do
    sleep 30
    local count
    count=$(ledger_count)
    if [ "$count" != "$last_count" ]; then
      last_count="$count"
      last_progress=$(date +%s)
      started_phase_b=1
    elif [ "$started_phase_b" -eq 1 ]; then
      now=$(date +%s)
      if [ $((now - last_progress)) -ge "$STALL_SECS" ]; then
        log "chunk stalled: no ledger rows for ${STALL_SECS}s; killing pid $pid"
        # The pool holds ~$CONCURRENCY worker threads; TERM lets them unwind
        # and the ledger keep what it already has.
        kill -TERM "$pid" 2>/dev/null
        sleep 20
        kill -KILL "$pid" 2>/dev/null
        wait "$pid" 2>/dev/null
        return 124
      fi
    fi
    status "running pid=$pid ledger=$count"
  done

  wait "$pid"
  return $?
}

trap 'log "supervisor stopping (signal)"; status stopped; exit 0' INT TERM

log "=== transcription supervisor started (chunk=$CHUNK concurrency=$CONCURRENCY spend=$SPEND) ==="
status starting

backoff="$BACKOFF_MIN"
consecutive_failures=0

while true; do
  remaining=$(papers_remaining)
  if [ "$remaining" = "-1" ]; then
    log "could not count remaining papers; backing off ${backoff}s"
    status "degraded: cannot read corpus"
    sleep "$backoff"
    backoff=$(( backoff * 2 )); [ "$backoff" -gt "$BACKOFF_MAX" ] && backoff="$BACKOFF_MAX"
    continue
  fi

  log "$remaining papers remaining"
  if [ "$remaining" -eq 0 ]; then
    log "=== all papers transcribed ==="
    status complete
    break
  fi

  # Before spending anything, ask whether the provider is answering. A bad
  # stretch here means the next chunk would just manufacture `failed` rows.
  fail_pct=$(recent_failure_pct)
  if [ "${fail_pct:-0}" -ge "$UNHEALTHY_PCT" ]; then
    log "provider unhealthy: ${fail_pct}% of recent completions failed; waiting ${backoff}s"
    status "waiting: provider ${fail_pct}% failures"
    sleep "$backoff"
    backoff=$(( backoff * 2 )); [ "$backoff" -gt "$BACKOFF_MAX" ] && backoff="$BACKOFF_MAX"
    continue
  fi

  status "running chunk"
  run_chunk
  chunk_status=$?

  if [ "$chunk_status" -eq 0 ]; then
    consecutive_failures=0
    backoff="$BACKOFF_MIN"
    log "chunk finished cleanly"
  else
    consecutive_failures=$(( consecutive_failures + 1 ))
    log "chunk exited $chunk_status (consecutive failures: $consecutive_failures/$MAX_CONSECUTIVE_FAILURES)"
    if [ "$consecutive_failures" -ge "$MAX_CONSECUTIVE_FAILURES" ]; then
      # Give up rather than hammer a provider that is plainly down, or retry a
      # fault that is not transient. The ledger keeps everything already paid
      # for, so restarting later costs nothing.
      log "=== giving up after $consecutive_failures consecutive failures ==="
      status "failed: $consecutive_failures consecutive chunk failures"
      exit 1
    fi
    status "backing off ${backoff}s after chunk failure"
    sleep "$backoff"
    backoff=$(( backoff * 2 )); [ "$backoff" -gt "$BACKOFF_MAX" ] && backoff="$BACKOFF_MAX"
  fi

  [ "$ONCE" = "1" ] && { log "ONCE set; stopping after one chunk"; status complete; break; }
done
