"use client";

import katex from "katex";
import type { V3AssetView } from "./types";

type StructuredBlock = {
  id: string;
  type: string;
  order: number;
  content: Record<string, unknown>;
};

type InlineSegment = { type: string; text?: string; latex?: string };

export function QuestionDocumentRenderer({ document, assets }: { document: unknown; assets: V3AssetView[] }) {
  const parsed = asQuestionDocument(document);
  const assetMap = new Map(assets.map((asset) => [asset.id, asset]));
  if (!parsed) return <p className="v3-render-error">This record does not match QuestionDocumentV1.</p>;
  return (
    <div className="v3-document" data-testid="v3-question-document">
      {parsed.blocks.sort((left, right) => left.order - right.order).map((block) => (
        <BlockRenderer key={block.id} block={block} assets={assetMap} />
      ))}
    </div>
  );
}

function BlockRenderer({ block, assets }: { block: StructuredBlock; assets: Map<string, V3AssetView> }) {
  const content = block.content;
  if (block.type === "paragraph") return <p><Inline segments={inlineSegments(content.segments)} /></p>;
  if (block.type === "caption") return <p className="v3-caption"><Inline segments={inlineSegments(content.segments)} /></p>;
  if (block.type === "source_excerpt") {
    return <blockquote>{typeof content.label === "string" && <strong>{content.label}</strong>}<Inline segments={inlineSegments(content.segments)} /></blockquote>;
  }
  if (block.type === "math") {
    return <Math latex={stringValue(content.latex)} display={content.displayMode === "display"} />;
  }
  if (block.type === "subpart") {
    return (
      <section className="v3-subpart">
        <div className="v3-subpart-label">{stringValue(content.label)}</div>
        <div className="v3-subpart-body">
          {structuredBlocks(content.blocks).sort((left, right) => left.order - right.order).map((child) => (
            <BlockRenderer key={child.id} block={child} assets={assets} />
          ))}
        </div>
        {typeof content.marks === "number" && <span className="v3-marks">[{content.marks}]</span>}
      </section>
    );
  }
  if (block.type === "list") {
    const items = Array.isArray(content.items) ? content.items : [];
    const List = content.style === "ordered" ? "ol" : "ul";
    return (
      <List className={content.style === "choices" ? "v3-choice-list" : undefined}>
        {items.map((item, index) => {
          const value = asRecord(item);
          return (
            <li key={stringValue(value.id, `${block.id}-${index}`)}>
              {typeof value.label === "string" && <span className="v3-choice-label">{value.label}</span>}
              {structuredBlocks(value.blocks).map((child) => <BlockRenderer key={child.id} block={child} assets={assets} />)}
            </li>
          );
        })}
      </List>
    );
  }
  if (block.type === "figure") {
    const asset = assets.get(stringValue(content.assetId));
    if (!asset) return <div className="v3-missing-asset">Figure unavailable</div>;
    const caption = stringValue(content.caption, asset.caption ?? "");
    return (
      <figure className="v3-figure">
        {/* Content-addressed assets are served by the validated V3 route. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={asset.url} width={asset.width} height={asset.height} alt={caption || asset.role} />
        {caption && <figcaption>{caption}</figcaption>}
      </figure>
    );
  }
  if (block.type === "table") return <SemanticTable blockId={block.id} content={content} assets={assets} />;
  return null;
}

function SemanticTable({ blockId, content, assets }: { blockId: string; content: Record<string, unknown>; assets: Map<string, V3AssetView> }) {
  const rows = Array.isArray(content.rows) ? content.rows : [];
  const caption = stringValue(content.caption);
  const fallback = assets.get(stringValue(content.fallbackAssetId));
  return (
    <div className="v3-table-wrap">
      <table>
        {caption && <caption>{caption}</caption>}
        <tbody>
          {rows.map((rawRow, rowIndex) => {
            const row = asRecord(rawRow);
            const cells = Array.isArray(row.cells) ? row.cells : [];
            return (
              <tr key={stringValue(row.id, `${blockId}-row-${rowIndex}`)}>
                {cells.map((rawCell, cellIndex) => {
                  const cell = asRecord(rawCell);
                  const Cell = cell.header === true ? "th" : "td";
                  return (
                    <Cell
                      key={stringValue(cell.id, `${blockId}-cell-${rowIndex}-${cellIndex}`)}
                      rowSpan={numberValue(cell.rowSpan, 1)}
                      colSpan={numberValue(cell.colSpan, 1)}
                      scope={cell.header === true ? "col" : undefined}
                    >
                      {structuredBlocks(cell.content).map((child) => <BlockRenderer key={child.id} block={child} assets={assets} />)}
                    </Cell>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      {fallback && (
        <details className="v3-table-fallback">
          <summary>Original table crop</summary>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={fallback.url} width={fallback.width} height={fallback.height} alt="Original table crop for verification" />
        </details>
      )}
    </div>
  );
}

export function MarkSchemeRenderer({ document }: { document: unknown }) {
  const parsed = asRecord(document);
  const sections = Array.isArray(parsed.sections) ? parsed.sections : [];
  if (parsed.version !== "MarkSchemeDocumentV1") return <p className="v3-render-error">Invalid mark-scheme record.</p>;
  return (
    <div className="v3-mark-scheme">
      {sections.map((rawSection, sectionIndex) => {
        const section = asRecord(rawSection);
        const points = Array.isArray(section.points) ? section.points : [];
        return (
          <section key={stringValue(section.id, `section-${sectionIndex}`)}>
            <h4>{stringValue(section.label)}</h4>
            <ol>
              {points.map((rawPoint, pointIndex) => {
                const point = asRecord(rawPoint);
                return (
                  <li key={stringValue(point.id, `point-${pointIndex}`)}>
                    <div><Inline segments={inlineSegments(point.answer)} /></div>
                    {typeof point.markCode === "string" && <code>{point.markCode}</code>}
                    <span className="v3-marks">[{numberValue(point.marks, 0)}]</span>
                    <MarkSchemeNotes label="Alternative" groups={point.alternatives} />
                    <MarkSchemeNotes label="Accept" groups={point.acceptableAnswers} />
                    <MarkSchemeNotes label="Note" groups={point.notes} />
                  </li>
                );
              })}
            </ol>
          </section>
        );
      })}
    </div>
  );
}

function MarkSchemeNotes({ label, groups }: { label: string; groups: unknown }) {
  if (!Array.isArray(groups) || groups.length === 0) return null;
  return (
    <div className="v3-ms-notes">
      {groups.map((group, index) => <p key={`${label}-${index}`}><strong>{label}:</strong> <Inline segments={inlineSegments(group)} /></p>)}
    </div>
  );
}

function Inline({ segments }: { segments: InlineSegment[] }) {
  return <>{segments.map((segment, index) => segment.type === "math"
    ? <Math key={`math-${index}`} latex={segment.latex ?? ""} display={false} />
    : <span key={`text-${index}`}>{segment.text ?? ""}</span>)}</>;
}

function Math({ latex, display }: { latex: string; display: boolean }) {
  let html: string;
  try {
    html = katex.renderToString(latex, { displayMode: display, throwOnError: true, strict: "error", output: "html" });
  } catch {
    return <span className="v3-render-error" role="alert">Invalid formula</span>;
  }
  return <span className={display ? "v3-math-display" : "v3-math-inline"} aria-label={latex} dangerouslySetInnerHTML={{ __html: html }} />;
}

function asQuestionDocument(value: unknown): { version: string; rootNumber: string; blocks: StructuredBlock[] } | null {
  const record = asRecord(value);
  if (record.version !== "QuestionDocumentV1" || typeof record.rootNumber !== "string") return null;
  return { version: record.version, rootNumber: record.rootNumber, blocks: structuredBlocks(record.blocks) };
}

function structuredBlocks(value: unknown): StructuredBlock[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    if (typeof record.id !== "string" || typeof record.type !== "string" || typeof record.order !== "number") return [];
    return [{ id: record.id, type: record.type, order: record.order, content: asRecord(record.content) }];
  });
}

function inlineSegments(value: unknown): InlineSegment[] {
  if (!Array.isArray(value)) return [];
  const segments: InlineSegment[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (record.type === "text" && typeof record.text === "string") segments.push({ type: "text", text: record.text });
    if (record.type === "math" && typeof record.latex === "string") segments.push({ type: "math", latex: record.latex });
  }
  return segments;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
