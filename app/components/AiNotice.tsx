'use client';

import Link from 'next/link';

/**
 * The amber panel every AI-off / AI-degraded message is shown in.
 *
 * `AI_DISABLED_MESSAGE` names the path to the account page in prose -- "Open
 * Account Settings -> AI Provider" -- which is fine in a 503 body and useless
 * in a browser, where the student has to read it, work out that it is a place
 * rather than a sentence, and go and find it. Worse, it only appears *after*
 * they have written an answer and submitted it; nothing points at the key
 * before then.
 *
 * So every surface that surfaces one of these messages renders it through
 * here, and here it always ends in a real link. One component rather than the
 * four near-identical amber blocks that were drifting apart.
 */
export default function AiNotice({
  notices,
  className = '',
}: {
  /** One or more server-supplied messages. Empty entries are dropped. */
  notices: Array<string | null | undefined>;
  className?: string;
}) {
  const shown = notices.filter((n): n is string => Boolean(n && n.trim()));
  if (shown.length === 0) return null;

  return (
    <div
      className={`p-2.5 rounded-md bg-warning-subtle border border-warning-border text-xs text-warning space-y-1.5 ${className}`}
    >
      {shown.map((notice, i) => (
        <p key={i}>{notice}</p>
      ))}
      <p>
        <Link href="/account" className="font-semibold underline underline-offset-2">
          Open Account settings
        </Link>{' '}
        to add your own API key.
      </p>
    </div>
  );
}
