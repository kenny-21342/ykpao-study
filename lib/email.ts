/**
 * Transactional email, delivered through Resend.
 *
 * WHY RAW `fetch` AND NOT THE `resend` SDK: the same reasoning as
 * `lib/storage/sigv4.ts`. Resend's HTTP API is one POST with a JSON body; the
 * SDK would add a dependency (and its transitive tree) to every serverless
 * bundle to save about ten lines. There is nothing here worth a package for.
 *
 * WHY IT FAILS LOUDLY: email is not a nice-to-have for the flows that use it.
 * A password reset that silently drops the message leaves the student locked
 * out with a screen that says the mail is on its way. So a missing API key is
 * a configuration error that callers must handle, never a no-op — see
 * `isEmailConfigured()`, which lets a route detect the problem *before* it
 * does anything observable.
 */

/** Resend's send endpoint. */
const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/**
 * Sending identity. The domain must be verified in Resend or every send is
 * rejected with a 403; see the deployment notes in `.env.example`.
 */
const DEFAULT_FROM = 'YKPao Study <no-reply@busypizza.bond>';

/** Raised when the transport is not configured. Distinct so routes can map it
 *  to a 503 ("we are misconfigured") rather than a 500 ("we crashed"). */
export class EmailNotConfiguredError extends Error {
  constructor() {
    super(
      'RESEND_API_KEY is not set, so no email can be sent. Create an API key at ' +
        'https://resend.com/api-keys, verify the sending domain that EMAIL_FROM ' +
        'uses, and set RESEND_API_KEY in the environment. See .env.example.',
    );
    this.name = 'EmailNotConfiguredError';
  }
}

/** Raised when Resend accepted the request but refused the message. */
export class EmailDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailDeliveryError';
  }
}

/**
 * True when email can actually be sent.
 *
 * Check this at the *top* of a route, before any user lookup. Doing it later
 * makes the failure depend on whether the address existed, which turns a
 * misconfigured deploy into an account-enumeration oracle.
 */
export function isEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY?.trim());
}

/** The address messages are sent from. */
export function emailFrom(): string {
  return process.env.EMAIL_FROM?.trim() || DEFAULT_FROM;
}

export type OutgoingEmail = {
  to: string;
  subject: string;
  /** Plain-text part. Always send one: some clients show only this. */
  text: string;
  html: string;
};

/**
 * Send one message.
 *
 * Throws `EmailNotConfiguredError` if there is no API key and
 * `EmailDeliveryError` if Resend rejects the send. Never resolves on failure —
 * callers decide what the user is told.
 */
export async function sendEmail(message: OutgoingEmail): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) throw new EmailNotConfiguredError();

  let response: Response;
  try {
    response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: emailFrom(),
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
      // Well inside the 60s function ceiling; a mail API that has not answered
      // in ten seconds is not going to.
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new EmailDeliveryError(
      `Could not reach Resend: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!response.ok) {
    // Resend returns { name, message } on error. Read it as text first so a
    // non-JSON error page (proxy, outage) doesn't throw inside the handler.
    const detail = await response.text().catch(() => '');
    throw new EmailDeliveryError(
      `Resend rejected the message (HTTP ${response.status}): ${detail.slice(0, 500)}`,
    );
  }
}

/**
 * Absolute origin for links inside emails.
 *
 * Deliberately NOT derived from the request's Host header: an attacker who can
 * set that header would receive a reset link pointing at their own domain.
 * NEXTAUTH_URL is already required in production (lib/env.ts).
 */
export function appOrigin(): string {
  const configured = process.env.NEXTAUTH_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  return 'http://localhost:3000';
}
