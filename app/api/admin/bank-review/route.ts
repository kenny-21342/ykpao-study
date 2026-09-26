import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { bankAssetKey } from '@/lib/storage/keys';
import { indexBankQuestion, refreshRagIndex } from '@/lib/rag-index';
import { parseEntityId, parsePagination } from '@/lib/query-params';
import type { Prisma } from '@prisma/client';

export const dynamic = 'force-dynamic';

const stripSelect = {
  page: true,
  ordering: true,
  asset: { select: { sha256: true, width: true, height: true } },
} as const;

const paperSelect = {
  id: true,
  board: true,
  year: true,
  session: true,
  paperNumber: true,
  variant: true,
  timezone: true,
  docType: true,
  subject: { select: { name: true, code: true, level: true } },
} as const;

const questionSelect = {
  id: true, rootNumber: true, bodyMd: true, totalMarks: true,
  confidence: true, status: true, createdAt: true, reviewedBy: true, reviewedAt: true,
  paper: { select: paperSelect },
  reviewFlags: {
    where: { status: 'open' },
    orderBy: [{ severity: 'asc' }, { id: 'asc' }],
    take: 20,
    select: { id: true, issueType: true, severity: true, message: true },
  },
  strips: { orderBy: { ordering: 'asc' }, select: stripSelect },
  markScheme: {
    select: {
      status: true, answerMd: true, answerLetter: true,
      strips: { orderBy: { ordering: 'asc' }, select: stripSelect },
    },
  },
} satisfies Prisma.BankQuestionSelect;

type ReviewQuestion = Prisma.BankQuestionGetPayload<{ select: typeof questionSelect }>;

function stripView(strip: { page: number; ordering: number; asset: { sha256: string; width: number | null; height: number | null } }) {
  const key = bankAssetKey(strip.asset.sha256);
  return key ? { url: `/${key}`, page: strip.page, width: strip.asset.width, height: strip.asset.height } : null;
}

function questionView(question: ReviewQuestion) {
  return {
    id: question.id,
    rootNumber: question.rootNumber,
    bodyMd: question.bodyMd,
    totalMarks: question.totalMarks,
    confidence: question.confidence,
    status: question.status,
    reviewedBy: question.reviewedBy,
    reviewedAt: question.reviewedAt,
    openFlags: question.reviewFlags,
    strips: question.strips.map(stripView).filter((strip) => strip !== null),
    markScheme: question.markScheme ? {
      status: question.markScheme.status,
      answerMd: question.markScheme.answerMd,
      answerLetter: question.markScheme.answerLetter,
      strips: question.markScheme.strips.map(stripView).filter((strip) => strip !== null),
    } : null,
  };
}

/**
 * Bring the RAG index back in line with a question's status.
 *
 * `indexBankQuestion` withdraws an unpublished question from the index rather
 * than downgrading it, on its own stated grounds that "a wrong transcription
 * cited as fact is worse than no citation". Nothing here called it, so holding
 * a question left it fully searchable and citable -- which is the exact harm
 * that rule exists to prevent, and the reason an admin pressed Hold. Publishing
 * had the mirror problem: the question stayed invisible until someone ran
 * `scripts/reindex-bank.ts` by hand.
 *
 * Deliberately after the transaction, not inside it: indexing is several
 * queries and a chunk rewrite per question, and a paper-level reopen can touch
 * 44 of them (p95 is 38) -- far more than a 30s interactive transaction should
 * be holding open. `refreshRagIndex` is fail-soft, so a failure here is logged
 * and leaves the review action itself standing.
 */
async function syncQuestionIndex(questionIds: number[]) {
  for (const questionId of questionIds) {
    await refreshRagIndex(`bank-question:${questionId}`, () => indexBankQuestion(questionId));
  }
}

export async function GET(req: NextRequest) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const params = req.nextUrl.searchParams;
  const { page, limit, skip } = parsePagination(params, { defaultLimit: 10, maxLimit: 20 });
  const status = params.get('status') ?? 'open';
  const severity = params.get('severity') ?? 'high';
  const scope = params.get('scope') ?? 'questions';
  if (!['open', 'resolved', 'dismissed', 'all'].includes(status)
      || !['high', 'medium', 'low', 'all'].includes(severity)
      || !['questions', 'papers', 'all', 'unflagged'].includes(scope)) {
    return NextResponse.json({ error: 'Invalid review filter' }, { status: 400 });
  }

  if (scope === 'unflagged') {
    const heldWhere: Prisma.BankQuestionWhereInput = {
      status: 'needs_review',
      reviewFlags: { none: { status: 'open', severity: { in: ['high', 'medium'] } } },
      paper: { reviewFlags: { none: { questionId: null, status: 'open', severity: { in: ['high', 'medium'] } } } },
    };
    const [questions, total] = await Promise.all([
      prisma.bankQuestion.findMany({ where: heldWhere, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip, take: limit, select: questionSelect }),
      prisma.bankQuestion.count({ where: heldWhere }),
    ]);
    return NextResponse.json({
      items: questions.map((question) => ({
        id: -question.id,
        issueType: 'held_without_blockers',
        severity: 'none',
        message: 'This question is held without an open blocking QA flag. Inspect the full crop before publishing.',
        status: 'held',
        createdAt: question.createdAt,
        reviewedBy: question.reviewedBy,
        reviewedAt: question.reviewedAt,
        reviewNote: null,
        paper: question.paper,
        question: questionView(question),
      })),
      total, page, pageSize: limit, totalPages: Math.ceil(total / limit),
    });
  }

  const where = {
    ...(status !== 'all' && { status }),
    ...(severity !== 'all' && { severity }),
    ...(scope === 'questions' && { questionId: { not: null } }),
    ...(scope === 'papers' && { questionId: null }),
  };

  const [flags, total] = await Promise.all([
    prisma.bankReviewFlag.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip,
      take: limit,
      select: {
        id: true, questionId: true, issueType: true, severity: true,
        message: true, status: true, createdAt: true, reviewedBy: true, reviewedAt: true, reviewNote: true,
        paper: { select: paperSelect },
        question: { select: questionSelect },
      },
    }),
    prisma.bankReviewFlag.count({ where }),
  ]);

  return NextResponse.json({
    items: flags.map((flag) => ({
      id: flag.id,
      issueType: flag.issueType,
      severity: flag.severity,
      message: flag.message,
      status: flag.status,
      createdAt: flag.createdAt,
      reviewedBy: flag.reviewedBy,
      reviewedAt: flag.reviewedAt,
      reviewNote: flag.reviewNote,
      paper: flag.paper ?? flag.question?.paper ?? null,
      question: flag.question ? questionView(flag.question) : null,
    })),
    total,
    page,
    pageSize: limit,
    totalPages: Math.ceil(total / limit),
  });
}

export async function PATCH(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const body = await req.json().catch(() => null);
  const action = body?.action;

  if (['resolve', 'dismiss', 'reopen'].includes(action)) {
    const flagId = parseEntityId(String(body?.flagId ?? ''));
    if (flagId === null) return NextResponse.json({ error: 'Invalid flag id' }, { status: 400 });
    const note = typeof body?.note === 'string' ? body.note.trim() : '';
    if (note.length > 1000) return NextResponse.json({ error: 'Review note is too long' }, { status: 400 });
    if (action === 'dismiss' && !note) return NextResponse.json({ error: 'Explain why this flag is a false alarm' }, { status: 400 });
    const result = await prisma.$transaction(async (tx) => {
      const changed = await tx.bankReviewFlag.updateMany({
        where: { id: flagId, status: action === 'reopen' ? { in: ['resolved', 'dismissed'] } : 'open' },
        data: {
          status: action === 'resolve' ? 'resolved' : action === 'dismiss' ? 'dismissed' : 'open',
          reviewedBy: action === 'reopen' ? null : admin.id,
          reviewedAt: action === 'reopen' ? null : new Date(),
          reviewNote: action === 'reopen' ? null : note || null,
        },
      });
      // The questions this reopen actually takes off the shelf. Read before the
      // update and narrowed to `published`, because those are precisely the ones
      // whose index entry has to be withdrawn -- an already-held question has no
      // entry to remove. The update itself still covers the whole scope, as it
      // did before, so a re-hold also restamps `reviewedBy`/`reviewedAt`.
      let held: number[] = [];
      if (changed.count && action === 'reopen') {
        const flag = await tx.bankReviewFlag.findUnique({ where: { id: flagId }, select: { questionId: true, paperId: true, severity: true } });
        const scope: Prisma.BankQuestionWhereInput | null =
          flag?.questionId && ['high', 'medium'].includes(flag.severity) ? { id: flag.questionId }
          : flag?.paperId && ['high', 'medium'].includes(flag.severity) ? { paperId: flag.paperId }
          : null;
        if (scope) {
          held = (await tx.bankQuestion.findMany({ where: { ...scope, status: 'published' }, select: { id: true } }))
            .map((question) => question.id);
          await tx.bankQuestion.updateMany({
            where: scope,
            data: { status: 'needs_review', reviewedBy: admin.id, reviewedAt: new Date() },
          });
        }
      }
      return { changed, held };
    });
    if (result.changed.count === 0) return NextResponse.json({ error: 'Flag changed or no longer exists; refresh the queue' }, { status: 409 });
    await syncQuestionIndex(result.held);
    // Reported so the admin sees the reach of a paper-level reopen, which holds
    // every published question on the paper -- a median of 10 and up to 44.
    return NextResponse.json({ success: true, questionsHeld: result.held.length });
  }

  if (action === 'publish' || action === 'hold') {
    const questionId = parseEntityId(String(body?.questionId ?? ''));
    if (questionId === null) return NextResponse.json({ error: 'Invalid question id' }, { status: 400 });

    const result = await prisma.$transaction(async (tx) => {
      const question = await tx.bankQuestion.findUnique({
        where: { id: questionId },
        select: { id: true, paperId: true, strips: { take: 1, select: { assetId: true } } },
      });
      if (!question) return { error: 'Question not found', status: 404 };
      if (action === 'publish') {
        if (question.strips.length === 0) return { error: 'Question has no source crop', status: 409 };
        const blockers = await tx.bankReviewFlag.count({
          where: {
            status: 'open', severity: { in: ['high', 'medium'] },
            OR: [{ questionId }, { questionId: null, paperId: question.paperId }],
          },
        });
        if (blockers) return { error: `${blockers} blocking flag(s) are still open`, status: 409 };
      }
      await tx.bankQuestion.update({
        where: { id: questionId },
        data: { status: action === 'publish' ? 'published' : 'needs_review', reviewedBy: admin.id, reviewedAt: new Date() },
      });
      return { success: true };
    });
    if ('success' in result) await syncQuestionIndex([questionId]);
    return NextResponse.json(result, { status: 'status' in result ? result.status : 200 });
  }

  return NextResponse.json({ error: 'Unsupported review action' }, { status: 400 });
}
