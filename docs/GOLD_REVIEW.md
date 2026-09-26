# V4 gold review candidates

[`gold-candidates-v4.json`](gold-candidates-v4.json) contains 25 **unverified**
candidate roots from the local extraction store. It covers the six pilot
subjects with four examples each: a simple baseline, a multi-page root, a
figure or table, and a question held for review. One additional IB Economics
root exercises OCR fallback. Every listed source PDF exists locally.

The candidate file is a review worklist, not a gold set. `human_verified` is
false on every entry. The source hash, PDF path, root number, and page span
identify the case even if database row IDs differ between SQLite and Postgres.

For each selected root:

1. Open the PDF and inspect every source page and the rendered strips in Admin
   → Bank Review. Check the mark scheme PDF when one is listed.
2. Correct the transcription and record exact expected text, marks, figure
   associations, and source provenance in the gold-set format. Do not copy the
   model output as its own expected answer.
3. Record who checked it and when, then mark the candidate verified. Select at
   least 20 verified roots spanning the listed features before running the
   benchmark gate.

The OCR case currently has no transcription or linked mark scheme. It needs a
manual source-page annotation before it can become a gold item.
