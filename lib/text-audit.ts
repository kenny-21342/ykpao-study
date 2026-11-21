/**
 * Auditing a question's transcription against its scan.
 *
 * Pure: the prompt and the reading of the model's answer, so both can be tested
 * without a model or a database. `scripts/audit-bank-text.mts` does the I/O.
 */

export type TextAuditLevel = 'clean' | 'minor' | 'major';

export const TEXT_AUDIT_PROMPT = `You are auditing an automated transcription of an exam question. The image(s) show the printed question. Below is the transcription (markdown; LaTeX inside $..$; tables as HTML; each figure appears as an image placeholder standing for the diagram, graph or photo in the scan).

Decide whether a student could answer the question correctly using ONLY the transcription plus the figures. Check every number, unit, symbol, option letter and its wording, label reference (such as "Fig. 2.1"), and that no sub-part or answer option is missing or invented.

Do NOT report any of these -- they are expected:
- mark allocations such as [3] or (2 marks), and the "Total" line
- the question's own number (e.g. "2.") -- the app shows it separately
- answer lines, dotted lines or blank working space
- formatting choices (bold, spacing, table layout) that do not change the content
- text that belongs to a different question on the same page

Reply with JSON only: {"severity": "none" | "minor" | "major", "issues": ["short description", ...]}
- "major": a wrong or missing number, word, option or sub-part, or an invented one, such that the question could be misread or cannot be answered
- "minor": a harmless difference (a stray word, a trivial wording change)
- "none": faithful

TRANSCRIPTION:
`;

/** Read the model's reply. Anything unreadable is treated as unaudited (null), never as clean. */
export function parseTextAudit(reply: string): { level: TextAuditLevel; issues: string[] } | null {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { severity, issues } = parsed as { severity?: unknown; issues?: unknown };
  const list = Array.isArray(issues) ? issues.filter((i): i is string => typeof i === 'string').map((i) => i.trim()).filter(Boolean) : [];
  if (severity === 'none') return { level: 'clean', issues: list };
  if (severity === 'minor') return { level: 'minor', issues: list };
  if (severity === 'major') return { level: 'major', issues: list };
  return null;
}
