import type { Metadata } from 'next';
import { LegalPage, Section, Review } from '@/app/components/LegalPage';

export const metadata: Metadata = {
  title: 'Privacy — YKPao Study',
  description: 'What YKPao Study stores about you, who it is shared with, and how to get it back or delete it.',
};

/**
 * Drafted from what the code actually does, not from a template. Every factual
 * claim below is checkable in the repository:
 *
 *  - the account fields are `model User` in prisma/schema.prisma
 *  - the AI-key handling is lib/ai-credentials.ts (encrypted at rest with
 *    CREDENTIAL_ENCRYPTION_KEY, never returned to the client)
 *  - the sub-processors are the services the app is actually deployed on:
 *    Vercel, Neon, Cloudflare R2, Resend, Google (optional sign-in)
 *  - the AI disclosure is lib/ai.ts and lib/vision.ts, which POST the
 *    student's own answer text and images to whichever endpoint their key
 *    points at
 *
 * What is NOT checkable from the code -- retention, contact, jurisdiction, and
 * whether the school is involved at all -- is marked REVIEW.
 */
export default function PrivacyPolicy() {
  return (
    <LegalPage title="Privacy" updated="13 September 2026">
      <Section heading="The short version">
        <p>
          This is a study tool run by a student, not a company. It stores your account,
          the work you do in it, and what that work cost to mark. It does not sell
          anything, does not run advertising, and does not profile you for anyone else.
          The one thing worth reading carefully is section 4: when you ask for an answer
          to be marked, that answer leaves this platform.
        </p>
      </Section>

      <Section heading="1. What is stored about you">
        <ul>
          <li>
            <strong>Your account</strong> — your name, email address, a one-way hash of
            your password (never the password itself), your profile picture if you set
            one, and the subjects you pick during onboarding.
          </li>
          <li>
            <strong>Your work</strong> — answers you submit, the marks and feedback they
            receive, anything you draw on the scratchpad, your notes and notebooks, files
            you upload, and posts you make on the discussion board.
          </li>
          <li>
            <strong>Your progress</strong> — which questions you have attempted, what you
            got wrong, and the review schedule built from that.
          </li>
          <li>
            <strong>Usage and cost</strong> — for each AI request, the feature that made
            it, the model, the token counts and the estimated cost. This is what the
            Usage page shows you.
          </li>
          <li>
            <strong>Operational records</strong> — errors, and rate-limit counters keyed
            to your address or IP, kept so the platform can refuse abuse.
          </li>
        </ul>
        <p>
          There is no analytics tracker following you between pages, and no cookie is set
          for advertising. The only cookie that matters is the one that keeps you signed
          in.
        </p>
      </Section>

      <Section heading="2. Your AI key">
        <p>
          If you add your own AI provider key, it is encrypted before it is written to the
          database and is never sent back to your browser afterwards — not even to you. It
          is decrypted only at the moment a request is made on your behalf. Removing it
          from your account page deletes it.
        </p>
      </Section>

      <Section heading="3. Who runs the infrastructure">
        <p>
          The platform itself does not share your data with anyone for their own purposes,
          but it runs on services that necessarily process it on its behalf:
        </p>
        <ul>
          <li><strong>Vercel</strong> — hosting and request logs.</li>
          <li><strong>Neon</strong> — the database everything above is stored in.</li>
          <li><strong>Cloudflare R2</strong> — uploaded files, images and question crops.</li>
          <li><strong>Resend</strong> — the confirmation and password-reset emails.</li>
          <li>
            <strong>Google</strong> — only if you choose to sign in with a Google account,
            in which case Google tells the platform your name, address and picture.
          </li>
        </ul>
      </Section>

      <Section heading="4. What happens when something is marked by AI">
        <p>
          This is the disclosure that matters most. When you submit an answer for marking,
          ask the tutor a question, or generate a paper, the platform sends the relevant
          content to an AI provider over the internet. That content can include{' '}
          <strong>
            your written answer, a photograph or drawing of your working, the question and
            its mark scheme, and the surrounding conversation
          </strong>
          .
        </p>
        <p>
          Which provider receives it depends on the key in use: your own if you have added
          one, otherwise a shared key if an administrator has granted you access. The
          provider&apos;s own privacy terms then apply to that request, and this platform
          has no control over how long they keep it or whether they train on it. If that
          is not acceptable to you, do not use the AI features — everything else on the
          platform works without them.
        </p>
      </Section>

      <Section heading="5. What other students can see">
        <p>
          Your notes, attempts and scratchpads are private to you unless you share them.
          Sharing a notebook page with a classmate gives that person the access you chose,
          viewer or editor, until you remove it. Discussion board posts are visible to
          everyone signed in. Administrators can see account records and moderate posted
          content.
        </p>
      </Section>

      <Section heading="6. How long it is kept">
        <p>
          Your account and work are kept while the account exists.{' '}
          <Review>
            decide a retention period for attempts, usage records and deleted accounts,
            and whether anything is kept after a student leaves the school
          </Review>
        </p>
      </Section>

      <Section heading="7. Getting your data, or deleting it">
        <p>
          You can edit or delete your notes, uploads and posts yourself from inside the
          app at any time. For a copy of everything held about you, or for the account
          itself to be deleted, contact{' '}
          <Review>a contact address for data requests, and who answers them</Review>
        </p>
      </Section>

      <Section heading="8. Age and school involvement">
        <p>
          <Review>
            state whether this is an official school system or a student project used
            with permission, whether the school has approved it for under-18 students,
            and whether parental consent is needed
          </Review>
        </p>
      </Section>

      <Section heading="9. Changes">
        <p>
          If this policy changes in a way that affects what is collected or who receives
          it, the change will be announced in the app before it takes effect.
        </p>
      </Section>
    </LegalPage>
  );
}
