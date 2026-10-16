/**
 * Build a printable worksheet from selected bank questions.
 *
 * The PDF is written to object storage and a short-lived signed URL is returned
 * rather than the file itself: a Vercel function cannot send a response over
 * ~4.5 MB, and a worksheet of crops easily is. The URL is unguessable and
 * expires in an hour; the object itself is deleted after a day, when the same
 * user next exports.
 */
import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth';
import {
  buildWorksheet, ExportError, EXPORT_MAX_QUESTIONS, loadExportQuestions,
} from '@/lib/bank-export';
import { reportError } from '@/lib/error-reporting';
import { rateLimit } from '@/lib/rate-limit';
import { getStorage } from '@/lib/storage';
import { KEY_PREFIX } from '@/lib/storage/keys';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const exportLimiter = rateLimit({ intervalMs: 10 * 60_000, max: 6 });

const bodySchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(EXPORT_MAX_QUESTIONS),
  title: z.string().max(100).optional(),
  includeMarkScheme: z.boolean().optional(),
  layout: z.enum(['flow', 'onePerPage']).optional(),
});

const URL_TTL_SECONDS = 3600;
const KEEP_MS = 24 * 3600 * 1000;

/** Delete this user's worksheets older than a day. Best effort. */
async function sweepOld(userId: string) {
  const store = getStorage();
  const keys = await store.list(`${KEY_PREFIX.exports}/${userId}/`, 200);
  const cutoff = Date.now() - KEEP_MS;
  await Promise.all(
    keys.map((key) => {
      const stamp = Number(/-(\d{10,})\.pdf$/.exec(key)?.[1]);
      return Number.isFinite(stamp) && stamp < cutoff ? store.delete(key) : null;
    }),
  );
}

export async function POST(request: NextRequest) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: 'Sign in to export questions.' }, { status: 401 });

    if (!(await exportLimiter.check(user.id))) {
      return NextResponse.json(
        { error: 'You have exported several worksheets in a short time. Try again in a few minutes.' },
        { status: 429 },
      );
    }

    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: `Choose between 1 and ${EXPORT_MAX_QUESTIONS} questions to export.` },
        { status: 400 },
      );
    }
    const { title, includeMarkScheme = false, layout = 'flow' } = parsed.data;
    const ids = [...new Set(parsed.data.ids)];

    const questions = await loadExportQuestions(ids);
    if (questions.length === 0) {
      return NextResponse.json({ error: 'None of those questions are available.' }, { status: 404 });
    }

    const worksheet = await buildWorksheet(questions, {
      title: title ?? '',
      includeMarkScheme,
      onePerPage: layout === 'onePerPage',
    });

    const store = getStorage();
    const hash = createHash('sha256').update(worksheet.bytes).digest('hex').slice(0, 16);
    const key = `${KEY_PREFIX.exports}/${user.id}/${hash}-${Date.now()}.pdf`;
    const filename = `worksheet-${new Date().toISOString().slice(0, 10)}.pdf`;
    const body = Buffer.from(worksheet.bytes);
    await store.put(key, body, { contentType: 'application/pdf', cacheControl: 'private, max-age=3600' });
    void sweepOld(user.id).catch(() => undefined);

    const summary = {
      filename,
      pages: worksheet.pages,
      questions: worksheet.questions,
      requested: ids.length,
      withoutMarkScheme: worksheet.withoutMarkScheme,
      missingImages: worksheet.missingImages,
      expiresInSeconds: URL_TTL_SECONDS,
    };

    const url = await store.signedGetUrl(key, {
      expiresInSeconds: URL_TTL_SECONDS,
      contentType: 'application/pdf',
      contentDisposition: `attachment; filename="${filename}"`,
    });
    if (url) return NextResponse.json({ ...summary, url });

    // The local driver cannot sign URLs; hand the file back directly. Fine for
    // development, and only reachable there because production uses object storage.
    if (body.length > 4 * 1024 * 1024) {
      return NextResponse.json({ error: 'This worksheet is too large for local development.' }, { status: 500 });
    }
    return NextResponse.json({ ...summary, dataBase64: body.toString('base64') });
  } catch (error) {
    if (error instanceof ExportError) {
      return NextResponse.json({ error: error.message }, { status: 413 });
    }
    reportError(error, { routePath: '/api/bank/export', routeType: 'route', method: 'POST' });
    return NextResponse.json({ error: 'Could not build the worksheet. Try fewer questions.' }, { status: 500 });
  }
}
