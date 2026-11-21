import { NextResponse } from 'next/server';
import { sharedVisionCredential } from '@/lib/ai-credentials';
import { askAboutImage } from '@/lib/vision';

export const dynamic = 'force-dynamic';

// TEMPORARY diagnostic. Bearer CRON_SECRET only. Remove after use.
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'no' }, { status: 401 });
  }
  const logs: string[] = [];
  const orig = { warn: console.warn, error: console.error, log: console.log };
  console.warn = (...a: unknown[]) => { logs.push('warn: ' + a.map(String).join(' ')); };
  console.error = (...a: unknown[]) => { logs.push('error: ' + a.map(String).join(' ')); };
  const t = Date.now();
  let result: unknown = null;
  try {
    const { image } = await request.json();
    const cred = sharedVisionCredential();
    result = cred ? await askAboutImage(image, { question: 'What does the text say?' }, cred) : 'no credential';
  } catch (e) {
    logs.push('threw: ' + (e instanceof Error ? e.stack : String(e)));
  } finally {
    Object.assign(console, orig);
  }
  return NextResponse.json({ ms: Date.now() - t, result, logs });
}
