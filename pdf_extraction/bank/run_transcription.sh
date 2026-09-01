#!/bin/bash
# Drive the corpus transcription in bounded chunks.
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
set -u
cd "$(dirname "$0")/../.."

CHUNK="${CHUNK:-300}"
SPEND="${SPEND:-120}"
CONCURRENCY="${CONCURRENCY:-10}"
LOG="pdf_extraction/bank/transcription-run.log"

echo "=== transcription run started $(date) ===" >> "$LOG"
while true; do
  remaining=$(python3 - <<'PY'
import sys
sys.path.insert(0, ".")
from pdf_extraction.bank.corpus_run import collect, transcribed
done = transcribed()
print(sum(1 for p in collect() if str(p) not in done))
PY
)
  echo "[$(date +%H:%M:%S)] $remaining papers remaining" >> "$LOG"
  if [ "$remaining" -eq 0 ]; then
    echo "=== all papers transcribed $(date) ===" >> "$LOG"
    break
  fi

  python3 -m pdf_extraction.bank.corpus_run \
      --use-model --no-tagging \
      --chunk "$CHUNK" --concurrency "$CONCURRENCY" --max-spend "$SPEND" >> "$LOG" 2>&1
  status=$?
  if [ $status -ne 0 ]; then
    echo "=== chunk exited $status; stopping $(date) ===" >> "$LOG"
    break
  fi
done
