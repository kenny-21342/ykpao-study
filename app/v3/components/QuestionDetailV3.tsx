"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowLeft, BookOpenCheck, FileAudio, FileText } from "lucide-react";
import { MarkSchemeRenderer, QuestionDocumentRenderer } from "./QuestionDocumentRenderer";
import type { V3QuestionDetail } from "./types";

export function QuestionDetailV3({ id }: { id: string }) {
  const [question, setQuestion] = useState<V3QuestionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/v3/questions/${encodeURIComponent(id)}`, { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? "Could not load question");
        return payload as V3QuestionDetail;
      })
      .then(setQuestion)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load question");
      });
    return () => controller.abort();
  }, [id]);

  if (error) return <main className="v3-detail"><div className="v3-empty"><h1>Question unavailable</h1><p>{error}</p><Link href="/v3/questions">Return to questions</Link></div></main>;
  if (!question) return <main className="v3-detail"><div className="v3-detail-skeleton" /></main>;
  const paper = question.paper;
  return (
    <main className="v3-detail">
      <Link href="/v3/questions" className="v3-back"><ArrowLeft /> All questions</Link>
      <header className="v3-detail-header">
        <div className="v3-question-number">{question.rootNumber}</div>
        <div>
          <h1>{paper.subjectCode} {paper.subjectName}</h1>
          <p>{paper.board} · {paper.qualification} · {paper.level} · {paper.year} {titleCase(paper.session)}</p>
        </div>
        <dl>
          <div><dt>Paper</dt><dd>{paper.paperNumber}</dd></div>
          <div><dt>Type</dt><dd>{titleCase(paper.paperType)}</dd></div>
          <div><dt>Component</dt><dd>{paper.component || "—"}</dd></div>
          <div><dt>Variant / timezone</dt><dd>{variantTimezone(paper.variant, paper.timezone)}</dd></div>
          <div><dt>Marks</dt><dd>{question.marks ?? "—"}</dd></div>
          <div><dt>Language</dt><dd>{paper.language.toUpperCase()}</dd></div>
        </dl>
      </header>
      <article className="v3-detail-question">
        <QuestionDocumentRenderer document={question.document} assets={question.assets} />
      </article>
      <div className="v3-label-band">
        <div><strong>Syllabus</strong>{question.topics.map((topic) => <span className="v3-topic-label" key={topic.id}>{topic.label}</span>)}</div>
        <div><strong>Tags</strong>{question.tags.map((tag) => <span className="v3-tag-label" key={tag.id}>{tag.label}</span>)}</div>
      </div>
      {question.resources.length > 0 && (
        <section className="v3-resources">
          <h2>Paper resources</h2>
          <ul>{question.resources.map((resource) => <li key={resource.id}>{resource.type === "audio" ? <FileAudio /> : <FileText />}<span><strong>{resource.label}</strong><small>{resource.type.replace(/_/g, " ")}</small></span></li>)}</ul>
        </section>
      )}
      {question.markScheme && (
        <details className="v3-ms-panel">
          <summary><BookOpenCheck /> Mark scheme <span>{question.markScheme.marks ?? question.marks ?? "—"} marks</span></summary>
          <MarkSchemeRenderer document={question.markScheme.document} />
        </details>
      )}
      <footer className="v3-provenance-line">Schema {question.schemaVersion} · Source {question.sourceHash.slice(0, 12)} · {question.sourceDocument.pageCount} pages</footer>
    </main>
  );
}

function titleCase(value: string) {
  return value.replace(/-/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function variantTimezone(variant: string, timezone: string) {
  return [variant && `Variant ${variant}`, timezone].filter(Boolean).join(" / ") || "Standard";
}
