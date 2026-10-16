/**
 * The paper- and part-level filters for the Practice list, as plain where-clause
 * fragments.
 *
 * Kept pure (no Prisma import) so the semantics can be tested without a
 * database. `listBankQuestions` spreads these into its query.
 *
 * Part-level matching: a multi-part question has rows in `bank_question_parts`,
 * each with its own topic and difficulty. A question matches a topic or level
 * filter if ANY of its parts does. A question with no part rows (every
 * single-part question, and every multi-part one not tagged yet) is judged on
 * its own question-level topic and difficulty, exactly as before -- so these
 * filters never make a question disappear just because the part pass has not
 * reached it.
 *
 * Every branch is an EXISTS over one table, never a join across two. An OR
 * spanning joined tables is what made every earlier slow search slow.
 */

export type PaperFilterInput = {
  paperNumbers?: number[];
  variants?: number[];
  /** 'TZ1' | 'TZ2' | 'TZ3', or 'TZ0' for papers sat with no time zone. */
  timezones?: string[];
};

/** Clauses that go on the PAPER. */
export function paperClauses(input: PaperFilterInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (input.paperNumbers?.length) out.paperNumber = { in: input.paperNumbers };
  if (input.variants?.length) out.variant = { in: input.variants };
  if (input.timezones?.length) {
    const zones = input.timezones.filter((zone) => zone !== 'TZ0');
    const none = input.timezones.includes('TZ0');
    const branches: Array<Record<string, unknown>> = [];
    if (zones.length) branches.push({ timezone: { in: zones } });
    if (none) branches.push({ timezone: null });
    out.AND = [{ OR: branches }];
  }
  return out;
}

export type PartFilterInput = {
  topic?: string | null;
  /** Any of these levels (1-5). */
  levels?: number[];
};

/** Clauses that go on the QUESTION; combine with AND. */
export function questionClauses(input: PartFilterInput): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  if (input.topic) {
    out.push({
      OR: [
        { topics: { some: { topic: { name: input.topic } } } },
        { partRows: { some: { topic: input.topic } } },
      ],
    });
  }
  if (input.levels?.length) {
    out.push({
      OR: [
        { partRows: { some: { difficulty: { in: input.levels } } } },
        { AND: [{ partRows: { none: {} } }, { difficulty: { in: input.levels } }] },
      ],
    });
  }
  return out;
}

/** "1,2,3" -> [1,2,3]; anything else is dropped. At most `max` values. */
export function parseIntList(value: string | null | undefined, max = 10, low = 0, high = 99): number[] {
  if (!value) return [];
  const out: number[] = [];
  for (const piece of value.split(',')) {
    if (!/^\d{1,2}$/.test(piece.trim())) continue;
    const n = Number(piece);
    if (n >= low && n <= high && !out.includes(n)) out.push(n);
    if (out.length >= max) break;
  }
  return out;
}

export function parseZoneList(value: string | null | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  for (const piece of value.split(',')) {
    const zone = piece.trim().toUpperCase();
    if (/^TZ[0-3]$/.test(zone) && !out.includes(zone)) out.push(zone);
  }
  return out;
}
