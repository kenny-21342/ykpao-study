import assert from "node:assert/strict";
import test from "node:test";
import { QuestionDocumentV1Schema, normalizeQuestionDocument, validateLatex } from "../lib/v3/contracts.ts";
import { canonicalJson, stableId } from "../lib/v3/ids.ts";

function question(latex = "x^2 + 1") {
  return {
    version: "QuestionDocumentV1",
    rootNumber: "1",
    marks: 2,
    blocks: [
      {
        id: "block-1",
        type: "paragraph",
        order: 0,
        provenance: [{ sourceDocumentId: "doc-1", page: 1, nativeBlockIds: ["native-1"] }],
        content: { segments: [{ type: "text", text: "  Find\n the value.  " }] },
      },
      {
        id: "block-2",
        type: "math",
        order: 1,
        provenance: [{ sourceDocumentId: "doc-1", page: 1, nativeBlockIds: ["native-2"] }],
        content: { latex, displayMode: "display" },
      },
    ],
  };
}

test("QuestionDocumentV1 normalizes prose without using PDF newlines for layout", () => {
  const normalized = normalizeQuestionDocument(question());
  const paragraph = normalized.blocks[0].content as { segments: Array<{ text: string }> };
  assert.equal(paragraph.segments[0].text, "Find the value.");
  assert.equal(QuestionDocumentV1Schema.safeParse(normalized).success, true);
});

test("KaTeX validation rejects delimiters and malformed commands", () => {
  assert.equal(validateLatex("x^2 + 1", true), null);
  assert.match(validateLatex("$x^2$", false) ?? "", /delimiter-free/);
  assert.notEqual(validateLatex(String.raw`\definitelyNotAKatexCommand{x}`, false), null);
  assert.equal(QuestionDocumentV1Schema.safeParse(question("$x$" )).success, false);
});

test("stable ids do not depend on object key order", () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
  assert.equal(stableId("v3q", { b: 2, a: 1 }), stableId("v3q", { a: 1, b: 2 }));
});
