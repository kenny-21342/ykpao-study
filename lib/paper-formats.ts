/**
 * The exam boards' own paper figures, as data.
 *
 * Two files, because the two boards had to be read in completely different
 * ways and the distinction is worth keeping visible:
 *
 *  - `ops/syllabus/formats.json` -- Cambridge, from the published syllabus,
 *    fetched by `scripts/fetch_syllabus_formats.py`. Keyed by syllabus code;
 *    Cambridge states one structure per code, with no HL/SL split.
 *  - `ops/syllabus/ib-formats.json` -- the IB, read off the papers' own cover
 *    pages by `scripts/read_ib_paper_covers.py`, because the IB's assessment
 *    outline is behind MyIB and its public briefs describe only the current
 *    structure. Keyed by subject slug *and level*, which the IB does split.
 *
 * Imported rather than read at runtime: they are a few kilobytes, they change
 * only when a script is re-run, and a serverless function that reads a file
 * from the repo is a deployment problem waiting to happen.
 */
import cambridge from '../ops/syllabus/formats.json';
import ib from '../ops/syllabus/ib-formats.json';
import type { FormatSource, OfficialFormat } from '@/lib/paper-format-overlay';

type RawPaper = {
  paperNumber: string;
  name: string | null;
  minutes: number | null;
  marks: number;
  weightingPercent: number | null;
  level?: string | null;
};

/**
 * Levels are compared loosely because the vocabularies were written years
 * apart: a course says "A Level", `bank_subjects` says "a-level", an IB course
 * says "HL". The same normalisation `chooseTemplate` uses, and for the same
 * reason -- comparing raw strings matched nothing and the fallback hid it.
 */
const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

function index(): Map<string, OfficialFormat> {
  const out = new Map<string, OfficialFormat>();
  const put = (code: string, level: string | null, p: RawPaper, source: FormatSource) => {
    const key = `${code}\u0000${level ? norm(level) : ''}\u0000${Number(p.paperNumber)}`;
    if (!out.has(key)) {
      out.set(key, {
        name: p.name, minutes: p.minutes, marks: p.marks,
        weightingPercent: p.weightingPercent, source,
      });
    }
  };
  for (const [code, entry] of Object.entries(cambridge as Record<string, { papers: RawPaper[] }>)) {
    for (const p of entry.papers) put(code, null, p, 'cambridge-syllabus');
  }
  for (const [code, entry] of Object.entries(ib as Record<string, { papers: RawPaper[] }>)) {
    for (const p of entry.papers) put(code, p.level ?? null, p, 'ib-paper-cover');
  }
  return out;
}

const BY_KEY = index();

/**
 * The official figures for one paper, or null when the board published none we
 * could read.
 *
 * Tries the level first and then without it, so a Cambridge subject -- which
 * has one structure for every level -- is found by an A-level course asking
 * for "a-level", while an IB subject still gets the HL row rather than the SL
 * one. A miss is normal and means the caller keeps the measured figures.
 */
export function officialFormat(
  subjectCode: string,
  level: string | null,
  paperNumber: number,
): OfficialFormat | null {
  const tail = `\u0000${paperNumber}`;
  return (level ? BY_KEY.get(`${subjectCode}\u0000${norm(level)}${tail}`) : undefined)
    ?? BY_KEY.get(`${subjectCode}\u0000${tail}`)
    ?? null;
}

/** How many paper groups carry official figures. For the admin view and tests. */
export function officialFormatCount(): number {
  return BY_KEY.size;
}
