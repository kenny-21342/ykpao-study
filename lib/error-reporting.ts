import { prisma } from '@/lib/prisma';
import { fingerprintOf, redactSecrets } from './error-redaction.ts';

export { redactSecrets };

/**
 * Where server-side errors go.
 *
 * There is no third-party error service on this project, and until now there
 * was nothing at all: mock-exam generation returned 504 to every student for
 * days and the only trace was a console line nobody reads. This writes each
 * error to `error_events` so the admin console can show what is breaking, and
 * optionally pushes a copy to ERROR_WEBHOOK_URL (a Slack or Discord incoming
 * webhook, or anything that accepts JSON) so a new failure can page someone.
 *
 * Nothing here may throw. It runs on the failure path, and an error reporter
 * that fails a request is worse than no error reporter.
 */

/** Message and stack are truncated to keep one bad loop from filling the table. */
const MAX_MESSAGE = 2_000;
const MAX_STACK = 8_000;

/** Chance of pruning old rows on any given report. */
const PRUNE_PROBABILITY = 0.02;
const RETENTION_DAYS = 30;

export type ErrorContext = {
  path?: string;
  method?: string;
  routePath?: string;
  routeType?: string;
  digest?: string;
  /** 'request' for anything Next caught; name the job for background work. */
  source?: string;
};

export async function reportError(error: unknown, context: ErrorContext = {}): Promise<void> {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = redactSecrets(rawMessage).slice(0, MAX_MESSAGE);
  const stack =
    error instanceof Error && error.stack
      ? redactSecrets(error.stack).slice(0, MAX_STACK)
      : null;

  // Always log, even if the write below fails: the platform's own log is the
  // last resort and costs nothing.
  console.error(
    '[error] %s %s (%s): %s',
    context.method ?? '-',
    context.path ?? '-',
    context.routeType ?? context.source ?? 'unknown',
    message,
  );

  try {
    await prisma.errorEvent.create({
      data: {
        fingerprint: fingerprintOf(message, context.routePath),
        message,
        stack,
        digest: context.digest ?? null,
        path: context.path ?? null,
        method: context.method ?? null,
        routePath: context.routePath ?? null,
        routeType: context.routeType ?? null,
        source: context.source ?? 'request',
      },
    });
  } catch (err) {
    console.error('[error] could not persist the error above:', err);
  }

  const webhook = process.env.ERROR_WEBHOOK_URL;
  if (webhook) {
    try {
      await fetch(webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // `text` is what Slack and Discord both read, so one shape fits both.
        body: JSON.stringify({
          text: `YKPao Study error — ${context.method ?? ''} ${context.path ?? context.source ?? ''}\n${message}`,
        }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (err) {
      console.error('[error] webhook delivery failed:', err);
    }
  }

  if (Math.random() < PRUNE_PROBABILITY) {
    try {
      await prisma.errorEvent.deleteMany({
        where: {
          createdAt: { lt: new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000) },
        },
      });
    } catch {
      // Housekeeping only.
    }
  }
}
