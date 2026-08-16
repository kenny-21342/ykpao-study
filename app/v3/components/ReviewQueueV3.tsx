"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, RefreshCw, Save, X } from "lucide-react";
import { MarkSchemeRenderer, QuestionDocumentRenderer } from "./QuestionDocumentRenderer";
import type { V3AssetView, V3PaperView } from "./types";

type ReviewIssue = {
  id: string;
  issueType: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  fieldPath: string | null;
  message: string;
  createdAt: string;
  runId: string;
  paper: V3PaperView;
  sourceCrop: V3AssetView | null;
  question: null | { id: string; rootNumber: string; confidence: number; document: unknown; assets: V3AssetView[] };
  markScheme: null | { id: string; rootNumber: string; confidence: number; document: unknown };
};

type ReviewResponse = { total: number; page: number; pageCount: number; items: ReviewIssue[] };

export function ReviewQueueV3() {
  const [response, setResponse] = useState<ReviewResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [issueType, setIssueType] = useState("");
  const [maxConfidence, setMaxConfidence] = useState("1");
  const [editor, setEditor] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const parameters = new URLSearchParams({ pageSize: "50", maxConfidence });
    if (issueType) parameters.set("issueType", issueType);
    const request = await fetch(`/api/v3/review?${parameters}`);
    const payload = await request.json();
    if (!request.ok) throw new Error(payload.error ?? "Could not load review queue");
    const next = payload as ReviewResponse;
    setResponse(next);
    const nextSelected = next.items[0] ?? null;
    setSelectedId(nextSelected?.id ?? null);
    setEditor(nextSelected ? JSON.stringify(nextSelected.question?.document ?? nextSelected.markScheme?.document ?? {}, null, 2) : "");
    setNote("");
  }, [issueType, maxConfidence]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Could not load review queue"));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const selected = response?.items.find((item) => item.id === selectedId) ?? null;

  function selectIssue(issue: ReviewIssue) {
    setSelectedId(issue.id);
    setEditor(JSON.stringify(issue.question?.document ?? issue.markScheme?.document ?? {}, null, 2));
    setNote("");
  }

  async function act(action: "correct" | "approve" | "reject" | "reextract") {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { action, note };
      if (action === "correct") body.document = JSON.parse(editor);
      const request = await fetch(`/api/v3/review/${selected.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await request.json();
      if (!request.ok) throw new Error(payload.error ?? "Review action failed");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Review action failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="v3-review-main">
      <div className="v3-review-toolbar">
        <div><h1>Extraction review</h1><p>{response?.total ?? 0} open issues</p></div>
        <label>Issue type<input value={issueType} onChange={(event) => setIssueType(event.target.value)} placeholder="All types" /></label>
        <label>Maximum confidence<input type="number" min="0" max="1" step="0.05" value={maxConfidence} onChange={(event) => setMaxConfidence(event.target.value)} /></label>
      </div>
      {error && <div className="v3-review-error" role="alert">{error}</div>}
      <div className="v3-review-grid">
        <aside className="v3-issue-list" aria-label="Review issues">
          {response?.items.map((issue) => (
            <button type="button" key={issue.id} onClick={() => selectIssue(issue)} data-selected={issue.id === selectedId}>
              <span className={`v3-severity v3-severity-${issue.severity.toLowerCase()}`}>{issue.severity}</span>
              <strong>{issue.issueType.replace(/_/g, " ")}</strong>
              <small>{issue.paper.subjectCode} · {issue.paper.year} · Q{issue.question?.rootNumber ?? issue.markScheme?.rootNumber ?? "—"}</small>
              <p>{issue.message}</p>
            </button>
          ))}
          {response?.items.length === 0 && <p className="v3-issue-empty">No issues match this queue.</p>}
        </aside>
        {selected ? (
          <section className="v3-review-workbench">
            <header>
              <div><span className={`v3-severity v3-severity-${selected.severity.toLowerCase()}`}>{selected.severity}</span><h2>{selected.issueType.replace(/_/g, " ")}</h2></div>
              <p>{selected.message}</p>
              {selected.fieldPath && <code>{selected.fieldPath}</code>}
            </header>
            <div className="v3-compare">
              <section aria-label="Source PDF crop">
                <h3>Source crop</h3>
                <div className="v3-source-crop">
                  {selected.sourceCrop ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={selected.sourceCrop.url} width={selected.sourceCrop.width} height={selected.sourceCrop.height} alt="Source PDF crop under review" />
                  ) : <p>No source crop is attached to this issue.</p>}
                </div>
              </section>
              <section aria-label="Rendered extraction">
                <h3>Rendered result</h3>
                <div className="v3-render-preview">
                  {selected.question
                    ? <QuestionDocumentRenderer document={selected.question.document} assets={selected.question.assets} />
                    : <MarkSchemeRenderer document={selected.markScheme?.document} />}
                </div>
              </section>
            </div>
            <section className="v3-correction-editor">
              <label htmlFor="v3-correction">Structured correction</label>
              <textarea id="v3-correction" value={editor} onChange={(event) => setEditor(event.target.value)} spellCheck={false} />
              <label htmlFor="v3-review-note">Review note</label>
              <input id="v3-review-note" value={note} onChange={(event) => setNote(event.target.value)} placeholder="Required when rejecting" />
            </section>
            <div className="v3-review-actions">
              <button type="button" onClick={() => act("correct")} disabled={saving} className="v3-action-neutral"><Save /> Save correction</button>
              <button type="button" onClick={() => act("reextract")} disabled={saving} className="v3-action-neutral"><RefreshCw /> Re-extract</button>
              <button type="button" onClick={() => act("reject")} disabled={saving || !note.trim()} className="v3-action-reject"><X /> Reject</button>
              <button type="button" onClick={() => act("approve")} disabled={saving} className="v3-action-approve"><Check /> Approve</button>
            </div>
          </section>
        ) : <section className="v3-review-workbench v3-review-none"><h2>Select an issue</h2></section>}
      </div>
    </main>
  );
}
