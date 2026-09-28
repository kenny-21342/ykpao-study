/**
 * Collapses search results that a reader cannot tell apart.
 *
 * The past-paper corpus holds more than one record for the same paper and root
 * question -- `ib-chemistry 2017 may Paper 2 Q4 mark scheme` resolves to four
 * distinct rows (21346, 21449, 21555, 21660). The title is built only from
 * subject, year, session, paper and root number, so all four render to the same
 * string, and a student saw the same mark scheme listed four times with no way
 * to choose between them.
 *
 * De-duplicating on the id would not have helped: the ids are genuinely
 * different. The visible identity is what matters, so that is the key.
 *
 * Deliberately NOT keyed on the url as well. A mark scheme's url carries its
 * question id, so those four rows have four different urls -- including the url
 * would keep every one of them and fix nothing. The trade-off is that two of a
 * student's own notes sharing a title collapse to one; that is already
 * degenerate, because every note result points at the same `/?tab=materials`
 * with no id, so the two rows differ by snippet alone.
 *
 * Order is preserved and the FIRST occurrence wins, which is why the caller
 * must pass the ranked RAG block ahead of the direct-query rows.
 */
export type DedupableResult = { type: string; title: string };

/** Case- and whitespace-insensitive, so near-identical titles collapse too. */
export function resultIdentity(row: DedupableResult): string {
  return `${row.type}:${row.title.trim().replace(/\s+/g, ' ').toLowerCase()}`;
}

export function dedupeSearchResults<T extends DedupableResult>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const key = resultIdentity(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}
