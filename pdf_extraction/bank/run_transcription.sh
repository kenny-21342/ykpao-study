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
# in place while a run is in flight can make the running copy jump into the
# middle of a line. Do not edit it in place. To change a live batch, write a
# new file and `mv` it over this path: rename swaps the inode, the running
# shell keeps reading the old one through its open descriptor, and the new
# version takes effect at the next restart.
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

# Prints the row count, or nothing at all if the database could not be read.
# Deliberately not `|| echo 0`: sqlite fails transiently while the pipeline is
# writing, and a fallback value is indistinguishable from a real count that
# happens to have changed. One such blip used to be read as progress, which
# started the stall clock during phase A -- and since phase A runs ~28 minutes
# against a 30 minute timeout, the watchdog killed each chunk just as it was
# about to begin paid work, forever.
ledger_count() {
  local n
  n=$(sqlite3 "file:${DB}?mode=ro" 'select count(*) from bank_run_ledger;' 2>/dev/null) || return 1
  case "$n" in
    ''|*[!0-9]*) return 1 ;;
    *) printf '%s' "$n" ;;
  esac
}

# Is the *provider* failing? Not: are questions failing.
#
# Two things this got wrong, both found on 17 Sep with the provider perfectly
# healthy and the supervisor refusing to spend a penny:
#
#   1. It counted every failure. But 40 of the last 40 failures were the model
#      returning unparseable JSON or transcribing the wrong question number --
#      content failures, on a provider answering normally. Those questions are
#      hard; the right response is to mark them failed and move on, not to stop
#      the corpus. Only transport failures mean "the provider is down".
#   2. It had no time bound, just the last 40 rows. So once work stopped the
#      window froze on whatever killed it, and every later check read the same
#      stale failures -- backing off forever, never retrying, because the only
#      thing that could refresh the window was the work it refused to start.
#
# Unknown failure text deliberately does not count as transport. A new outage
# signature will therefore not trigger backoff here, but it is still caught by
# the chunk-exit retry and the stall watchdog, and that is the safer way to be
# wrong: this function can only ever stop the run.
HEALTH_WINDOW_MIN="${HEALTH_WINDOW_MIN:-30}"
HEALTH_MIN_SAMPLE="${HEALTH_MIN_SAMPLE:-10}"

recent_failure_pct() {
  sqlite3 "file:${DB}?mode=ro" "
    select case
             when count(*) < ${HEALTH_MIN_SAMPLE} then 0
             else cast(round(100.0 * sum(transport) / count(*)) as int)
           end
      from (
        select case when status = 'failed' and (
                      detail like '%HTTPSConnectionPool%'
                   or detail like '%Connection%'
                   or detail like '%timed out%'
                   or detail like '%Timeout%'
                   or detail like '%502%'
                   or detail like '%503%'
                   or detail like '%504%'
                   or detail like '%429%'
                 ) then 1 else 0 end as transport
          from bank_run_ledger
         where completed_at >= datetime('now', '-${HEALTH_WINDOW_MIN} minutes')
         order by completed_at desc
         limit 60
      );" 2>/dev/null || echo 0
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
# The pipeline announces the start of paid work with a line like
# "transcribing 1659 items with 10 workers". Reading the marker is honest
# where inferring it from a counter is not: the counter cannot tell a first
# transcription apart from a failed read or from another process writing.
PHASE_B_MARKER="${PHASE_B_MARKER:-transcribing }"

run_chunk() {
  local log_start_bytes
  log_start_bytes=$(wc -c < "$LOG" 2>/dev/null || echo 0)

  if [ -n "$CHUNK_CMD" ]; then
    eval "$CHUNK_CMD" >> "$LOG" 2>&1 &
  else
  python3 -m pdf_extraction.bank.corpus_run \
      --use-model --no-tagging \
      --chunk "$CHUNK" --concurrency "$CONCURRENCY" --max-spend "$SPEND" >> "$LOG" 2>&1 &
  fi
  local pid=$!
  CHUNK_PID=$pid
  local last_count last_progress now started_phase_b=0
  last_count=$(ledger_count) || last_count=""
  last_progress=$(date +%s)

  while kill -0 "$pid" 2>/dev/null; do
    sleep 30

    # Has paid work begun? Only the part of the log this chunk wrote counts,
    # or every chunk after the first inherits its predecessor's marker.
    if [ "$started_phase_b" -eq 0 ] \
       && tail -c "+$(( log_start_bytes + 1 ))" "$LOG" 2>/dev/null | grep -q "$PHASE_B_MARKER"; then
      started_phase_b=1
      last_progress=$(date +%s)
    fi

    local count
    if ! count=$(ledger_count); then
      # Unreadable, not unchanged. Leave the stall clock where it is.
      status "running pid=$pid ledger=unreadable"
      continue
    fi
    if [ "$count" != "$last_count" ]; then
      last_count="$count"
      last_progress=$(date +%s)
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
        CHUNK_PID=""
        return 124
      fi
    fi
    status "running pid=$pid ledger=$count"
  done

  wait "$pid"
  local rc=$?
  CHUNK_PID=""
  return $rc
}

# The pid of the chunk currently in flight, so a signal can take it with us.
CHUNK_PID=""

# Without this the supervisor exits on TERM and leaves its chunk running,
# reparented to init. That is worse than not supervising at all: the next
# supervisor to start has no idea the orphan exists, so it launches a second
# chunk against the same corpus and both spend money on the same questions.
# Observed on 17 Sep -- pid 84026, PPID 1, still transcribing hours after the
# supervisor that started it had gone.
stop_chunk() {
  [ -n "$CHUNK_PID" ] || return 0
  kill -0 "$CHUNK_PID" 2>/dev/null || return 0
  log "stopping in-flight chunk $CHUNK_PID"
  # TERM first: the pool unwinds and the ledger keeps every question it has
  # already paid for. KILL only if it will not go.
  kill -TERM "$CHUNK_PID" 2>/dev/null
  local waited=0
  while kill -0 "$CHUNK_PID" 2>/dev/null && [ "$waited" -lt 20 ]; do
    sleep 1
    waited=$(( waited + 1 ))
  done
  kill -KILL "$CHUNK_PID" 2>/dev/null
}

on_signal() {
  log "supervisor stopping (signal)"
  stop_chunk
  status stopped
  exit 0
}
trap on_signal INT TERM

# --- single instance -------------------------------------------------------
#
# launchd's KeepAlive starts a replacement the moment this agent exits, and on
# 17 Sep it started one while the previous supervisor was still tearing down
# its chunk -- two supervisors, one ledger, one corpus, both driving chunks.
# The log shows it twice (10:53/11:19 and again at 14:15, where the loser was
# signalled 67s after starting).
#
# mkdir is the atomic primitive available everywhere; macOS ships no flock.
# The pid inside the directory is what lets a killed run's lock be reclaimed
# instead of wedging the batch until someone notices.
LOCK_DIR="${LOCK_DIR:-pdf_extraction/bank/.transcription.lock}"

acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo $$ > "$LOCK_DIR/pid"
    return 0
  fi
  local holder
  holder=$(cat "$LOCK_DIR/pid" 2>/dev/null || true)
  if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
    return 1
  fi
  log "clearing stale lock (pid ${holder:-unknown} is gone)"
  rm -rf "$LOCK_DIR"
  mkdir "$LOCK_DIR" 2>/dev/null || return 1
  echo $$ > "$LOCK_DIR/pid"
  return 0
}

# Only the holder releases it, so a refused start never clears the live run's
# lock on its way out.
release_lock() {
  if [ -f "$LOCK_DIR/pid" ] && [ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" = "$$" ]; then
    rm -rf "$LOCK_DIR"
  fi
}
trap release_lock EXIT

if ! acquire_lock; then
  log "another supervisor holds the lock (pid $(cat "$LOCK_DIR/pid" 2>/dev/null)); exiting"
  exit 0
fi

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
