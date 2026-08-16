import fs from "node:fs";
import { MarkSchemeDocumentV1Schema, QuestionDocumentV1Schema } from "../lib/v3/contracts.ts";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: node --experimental-strip-types scripts/v3-contract-check.mts <extraction.json>");
  process.exit(2);
}

const extraction = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const issues: Array<{
  issueType: "schema";
  severity: "critical";
  fieldPath: string;
  message: string;
}> = [];

for (const [index, question] of (extraction.questions ?? []).entries()) {
  const parsed = QuestionDocumentV1Schema.safeParse(question);
  if (!parsed.success) addIssues(`questions[${index}]`, parsed.error.issues);
}
for (const [index, markScheme] of (extraction.markSchemes ?? []).entries()) {
  const parsed = MarkSchemeDocumentV1Schema.safeParse(markScheme);
  if (!parsed.success) addIssues(`markSchemes[${index}]`, parsed.error.issues);
}

function addIssues(prefix: string, schemaIssues: Array<{ path: PropertyKey[]; message: string }>) {
  for (const issue of schemaIssues) {
    const suffix = issue.path.map((part) => typeof part === "number" ? `[${part}]` : `.${String(part)}`).join("");
    issues.push({
      issueType: "schema",
      severity: "critical",
      fieldPath: `${prefix}${suffix}`,
      message: issue.message,
    });
  }
}

process.stdout.write(`${JSON.stringify({ issues })}\n`);
process.exit(issues.length ? 1 : 0);
