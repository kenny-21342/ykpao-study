import fs from "node:fs";
import katex from "katex";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: node scripts/v3-katex-check.mjs <extraction.json>");
  process.exit(2);
}

const extraction = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const issues = [];

for (const document of [...(extraction.questions ?? []), ...(extraction.markSchemes ?? [])]) {
  if (document.version === "QuestionDocumentV1") walkBlocks(document.blocks ?? [], "blocks");
  if (document.version === "MarkSchemeDocumentV1") {
    for (const [sectionIndex, section] of (document.sections ?? []).entries()) {
      for (const [pointIndex, point] of (section.points ?? []).entries()) {
        const groups = [point.answer ?? [], ...(point.alternatives ?? []), ...(point.acceptableAnswers ?? []), ...(point.notes ?? [])];
        for (const segment of groups.flat()) {
          if (segment.type === "math") check(segment.latex, false, `sections[${sectionIndex}].points[${pointIndex}]`);
        }
      }
    }
  }
}

function walkBlocks(blocks, prefix) {
  for (const [index, block] of blocks.entries()) {
    const path = `${prefix}[${index}]`;
    const content = block.content ?? {};
    if (block.type === "math") check(content.latex, content.displayMode === "display", path);
    for (const segment of content.segments ?? []) {
      if (segment.type === "math") check(segment.latex, false, path);
    }
    if (content.blocks) walkBlocks(content.blocks, `${path}.content.blocks`);
    for (const [itemIndex, item] of (content.items ?? []).entries()) {
      walkBlocks(item.blocks ?? [], `${path}.content.items[${itemIndex}].blocks`);
    }
    for (const [rowIndex, row] of (content.rows ?? []).entries()) {
      for (const [cellIndex, cell] of (row.cells ?? []).entries()) {
        walkBlocks(cell.content ?? [], `${path}.content.rows[${rowIndex}].cells[${cellIndex}].content`);
      }
    }
  }
}

function check(latex, displayMode, fieldPath) {
  try {
    if (typeof latex !== "string" || /\$|\\\(|\\\)|\\\[|\\\]/.test(latex)) throw new Error("Math must be non-empty and delimiter-free");
    katex.renderToString(latex, { displayMode, throwOnError: true, strict: "error", output: "html" });
  } catch (error) {
    issues.push({
      issueType: "latex",
      severity: "critical",
      fieldPath,
      message: error instanceof Error ? error.message : "KaTeX rejected the expression",
    });
  }
}

process.stdout.write(`${JSON.stringify({ issues })}\n`);
process.exit(issues.length ? 1 : 0);
