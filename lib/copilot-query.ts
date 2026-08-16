import { prisma } from '@/lib/prisma';
import type { CopilotIntent, CopilotIntentName, CorpusCoverage } from '@/lib/copilot-types';

const SUBJECT_ALIASES: Array<[RegExp, string]> = [
  [/\bmaths?\b|mathematics/, 'mathematics'],
  [/\bbiology\b/, 'biology'],
  [/\bchemistry\b/, 'chemistry'],
  [/\bphysics\b/, 'physics'],
  [/\beconomics?\b/, 'economics'],
  [/\benglish\b/, 'english'],
  [/\bcomputer science|\bcs\b/, 'computer science'],
  [/\bgeography\b/, 'geography'],
  [/\bpsychology\b/, 'psychology'],
];

function intentName(message: string): CopilotIntentName {
  const text = message.toLowerCase();
  if (/\b(plan|roadmap|schedule|study week|revision plan|milestone|prepare me|exam date)\b/.test(text)) return 'planning';
  if (/\b(next|what should i do|recommend|recommendation|today)\b/.test(text)) return 'next-action';
  if (/\b(mistake|wrong|weakness|review|retry|error log)\b/.test(text)) return 'review';
  if (/\b(explain|understand|teach me|walk me through)\b/.test(text) && !/\b(find|search|show me)\b/.test(text)) return 'explanation';
  if (/\b(mock|past paper|practice paper|grade me|mark scheme|assessment|exam)\b/.test(text)) return 'assessment';
  if (/\b(practice|quiz|questions|question set|worksheet)\b/.test(text)) return 'practice';
  if (/\b(find|search|show me|material|notes|textbook|source|paper)\b/.test(text)) return 'discovery';
  return 'explanation';
}

function qualification(text: string) {
  if (/\b(ib|international baccalaureate|diploma programme|dp)\b/i.test(text)) return 'IB Diploma';
  if (/\bigcse\b/i.test(text)) return 'Cambridge IGCSE';
  if (/\b(as\s*(?:&|and)?\s*a\s*level|a[- ]level|a level|alevel)\b/i.test(text)) return 'Cambridge AS & A Level';
  return undefined;
}

function board(text: string, qual?: string) {
  if (qual === 'IB Diploma' || /\bIB\b|international baccalaureate/i.test(text)) return 'IB';
  if (qual?.startsWith('Cambridge') || /cambridge|igcse|a[- ]level|as level/i.test(text)) return 'Cambridge';
  return undefined;
}

export async function planCopilotQuery(message: string, options: { subjectCode?: string; level?: string } = {}): Promise<CopilotIntent> {
  const text = message.replace(/\s+/g, ' ').trim();
  const lower = text.toLowerCase();
  const name = intentName(text);
  const qual = qualification(text);
  const subject = SUBJECT_ALIASES.find(([pattern]) => pattern.test(lower))?.[1];
  const level = options.level || (/\bHL\b/i.test(text) ? 'HL' : /\bSL\b/i.test(text) ? 'SL' : /\bigcse\b/i.test(text) ? 'IGCSE' : /\bAS\b/i.test(text) ? 'AS' : /\bA[- ]?level\b/i.test(text) ? 'A Level' : undefined);
  const year = Number(text.match(/\b(20\d{2})\b/)?.[1]) || undefined;
  const paper = text.match(/\bpaper\s*([0-9]+[a-z]?)\b/i)?.[1]?.toUpperCase();
  const session = text.match(/\b(feb|may|jun|june|oct|nov|winter|summer|spring|autumn|s|w|o)\b/i)?.[1];
  const topicMatch = text.match(/(?:topic|chapter|unit|weakest in|on)\s+([a-z][a-z0-9 &/'-]{2,60})/i);
  const materialKinds = name === 'practice' || name === 'assessment' ? ['question', 'markscheme'] : ['note', 'textbook', 'resource', 'syllabus'];
  const provider = /step|competition|amc|aime/i.test(text) ? 'competition' : /official|past paper|mark scheme/i.test(text) ? 'official' : undefined;
  return {
    name,
    board: board(text, qual),
    qualification: qual,
    subjectCode: options.subjectCode,
    subject,
    level,
    topic: topicMatch?.[1]?.replace(/[?.!,]+$/, '').trim(),
    year,
    session,
    paper,
    provider,
    materialKinds,
    purpose: name === 'planning' ? 'plan' : name === 'practice' ? 'practice' : name === 'assessment' ? 'assess' : name === 'discovery' ? 'discover' : name === 'review' ? 'review' : name === 'next-action' ? 'plan' : 'explain',
    confidence: [qual, subject, level, year].filter(Boolean).length / 4,
  };
}

export async function corpusCoverageForIntent(intent: CopilotIntent, userId: string): Promise<CorpusCoverage> {
  try {
    const manifests = await prisma.ragCorpusManifest.findMany({
      where: {
        ...(intent.board ? { board: intent.board } : {}),
        ...(intent.qualification ? { qualification: intent.qualification } : {}),
        ...(intent.level ? { level: { contains: intent.level, mode: 'insensitive' as const } } : {}),
        ...(intent.subjectCode ? { subjectCode: intent.subjectCode } : {}),
      },
      orderBy: { updatedAt: 'desc' },
    });
    const owned = await prisma.ragDocument.count({
      where: {
        ownerId: userId,
        ...(intent.subjectCode ? { subjectCode: intent.subjectCode } : {}),
        ...(intent.topic ? { topic: { contains: intent.topic, mode: 'insensitive' as const } } : {}),
      },
    });
    if (manifests.length === 0 && owned === 0) {
      return { status: 'unavailable', label: 'No indexed corpus is available for this request yet.', questionCount: 0, markSchemeCount: 0, resourceCount: 0, noteCount: 0, availableYears: [], availablePapers: [], limitations: ['No matching official manifest or authorized personal material was indexed.'] };
    }
    const status = manifests.some((manifest) => manifest.extractionState === 'extracting')
      ? 'extracting'
      : manifests.some((manifest) => manifest.extractionState === 'partial') ? 'partial' : 'complete';
    const questionCount = manifests.reduce((sum, item) => sum + item.questionCount, 0);
    const markSchemeCount = manifests.reduce((sum, item) => sum + item.markSchemeCount, 0);
    const resourceCount = manifests.reduce((sum, item) => sum + item.resourceCount, 0);
    const availableYears = [...new Set(manifests.flatMap((item) => item.availableYears))].sort();
    const availablePapers = [...new Set(manifests.flatMap((item) => item.availablePapers))].sort();
    const limitations = status === 'complete' ? [] : [status === 'extracting' ? 'Some source files are still being extracted.' : 'The indexed corpus is partial; missing papers or mark schemes may remain.'];
    if (markSchemeCount < questionCount) limitations.push('Some official questions do not have a paired mark scheme yet.');
    return {
      status,
      label: `${availableYears.length ? `${availableYears[0]}-${availableYears[availableYears.length - 1]} papers` : 'Official papers'} indexed${status === 'complete' ? '' : `; extraction is ${status}`}.`,
      board: intent.board,
      qualification: intent.qualification,
      level: intent.level,
      subjectCode: intent.subjectCode,
      questionCount,
      markSchemeCount,
      resourceCount,
      noteCount: owned,
      availableYears,
      availablePapers,
      lastExtractionAt: manifests.map((item) => item.lastExtractionAt).find(Boolean)?.toISOString() ?? null,
      lastIndexingAt: manifests.map((item) => item.lastIndexingAt).find(Boolean)?.toISOString() ?? null,
      limitations,
    };
  } catch {
    return { status: 'partial', label: 'Coverage could not be fully checked; answers are limited to currently searchable material.', questionCount: 0, markSchemeCount: 0, resourceCount: 0, noteCount: 0, availableYears: [], availablePapers: [], limitations: ['Corpus manifest is not available yet.'] };
  }
}
