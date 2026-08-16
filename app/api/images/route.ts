import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { getStorage, KEY_PREFIX, publicPathFromKey } from '@/lib/storage';

/**
 * List the extracted diagram images belonging to one past paper.
 *
 * `pattern` is a paper stem such as "9702_s2024_2v1". It is matched as a key
 * prefix inside the `extracted_images/` storage prefix — validated so the route
 * can't be used to enumerate the whole bucket one character at a time.
 */

/** Cap on returned filenames, so a one-character pattern can't dump the bucket. */
const MAX_IMAGES = 200;

const PAPER_PATTERN_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const paperPattern = request.nextUrl.searchParams.get('pattern')?.trim();

  if (!paperPattern || !PAPER_PATTERN_RE.test(paperPattern)) {
    return NextResponse.json({ error: 'A valid paper pattern is required' }, { status: 400 });
  }

  try {
    const keys = await getStorage().list(
      `${KEY_PREFIX.extractedImages}/${paperPattern}`,
      MAX_IMAGES
    );
    return NextResponse.json({ images: keys.map(publicPathFromKey) });
  } catch (error: unknown) {
    console.error('[api/images] failed to list extracted images:', error);
    return NextResponse.json({ error: 'Failed to list images' }, { status: 500 });
  }
}
