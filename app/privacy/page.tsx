import type { Metadata } from 'next';
import { LegalPage, Section } from '@/app/components/LegalPage';

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
 *    Vercel, Neon, Cloudflare R2, Resend, a friend-run AI gateway and the
 *    vendors behind it, Google (optional sign-in).
 *    The database vendor has moved twice: Neon until 26 Sep 2026, Aiven from
 *    26 to 28 Sep, and Neon again from 28 Sep (a new project, us-east-1, on
 *    the Vercel Marketplace -- the two projects named here before were
 *    deleted on 26 Sep and share nothing with it). Aiven no longer processes
 *    anything once its plan is cancelled; until then it holds a copy of the
 *    pre-cutover data. Re-read this line whenever DATABASE_URL changes host.
 *  - the AI routing in section 4 is lib/shared-models.ts: the shared key goes
 *    to a New API gateway a friend of the owner runs and funds, which fronts
 *    models from eight vendors. The vendor list there is the one section 4
 *    names, so re-read section 4 whenever the gateway's line-up changes
 *  - the AI disclosure is lib/ai.ts and lib/vision.ts, which POST the
 *    student's own answer text and images to whichever endpoint their key
 *    points at
 *
 * What is NOT checkable from the code -- retention, contact, jurisdiction, and
 * whether the school is involved at all -- was left to the operator and has
 * since been decided, so nothing here is marked REVIEW any more. The draft
 * banner is still up: LEGAL_COPY_IS_DRAFT in app/components/LegalPage.tsx is
 * his to flip once he has read the filled-in copy back.
 */
export default function PrivacyPolicy() {
  return (
    <LegalPage title="Privacy" updated="28 September 2026">
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
            receive, anything you draw on the scratchpad, files you upload, and posts you
            make on the discussion board.
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
          <li>
            <strong>An AI gateway operated by Henry Yang</strong>, a friend of the person
            who runs this site, who provides the credit the shared key spends. It forwards
            what you send the tutor to whichever model you are using, so those vendors —
            OpenAI, Anthropic, Google, xAI, DeepSeek, Alibaba, Moonshot, Z.ai and MiniMax —
            receive it too. See section 4; this is the one that receives your schoolwork.
          </li>
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
          Which provider receives it depends on the key in use. If you have added your own
          API key, your key and your chosen model are used, and the platform never
          substitutes a different one. Otherwise the shared key is used, which every
          signed-in student can now reach — it is no longer something an administrator has
          to grant.
        </p>
        <p>
          The shared key does not talk to a model vendor directly. It goes through a
          gateway run by a private individual, Henry Yang, who funds it and who could in
          principle see what passes through it, and the gateway forwards your message to
          whichever vendor makes the model you picked. You can see and change that model in
          the tutor itself; each vendor&apos;s own terms then govern what they do with it,
          including whether they keep it or train on it.
        </p>
        <p>
          <strong>
            So treat anything you send the tutor as something that leaves this platform and
            is read by people and companies who are not part of your school.
          </strong>{' '}
          Do not send it anything you would not be willing to have seen — your own
          schoolwork is the point of it, but personal details about yourself or anyone else
          are not. This applies only to what you send the AI. Your notes, attempts and
          uploaded files are never sent anywhere for training.
        </p>
        <p>
          If you would rather that did not happen, you have two options that both work
          today: add your own API key under Account Settings → AI Provider, which is used
          in place of the shared one, or simply do not use the AI features. Everything else
          on the platform — past papers, the question bank, notes, mock exams — works
          without them.
        </p>
      </Section>

      <Section heading="5. What other students can see">
        <p>
          Your attempts and scratchpads are private to you. Anything you upload to the
          school resource library is visible to everyone signed in, with your name shown
          as the contributor, and so are discussion board posts. Administrators can see
          account records and moderate posted content.
        </p>
      </Section>

      <Section heading="6. How long it is kept">
        <p>
          Your account and work are kept for as long as the account exists. If you ask
          for your account to be deleted, it is removed along with everything attached
          to it — your attempts, notes, uploads, scratchpads and posts — within 30 days
          of the request.
        </p>
        <p>
          Two things outlive that. Encrypted database backups are kept for up to 90 days
          before being deleted, so a deleted account can survive in a backup for that
          long; backups are never used for anything but restoring the service. And usage
          records, which hold the size and cost of an AI request but none of its content,
          may be kept after deletion with the account identifier removed, so running
          costs can still be accounted for.
        </p>
        <p>
          Leaving the school does not delete anything by itself. If you want your account
          removed when you leave, ask.
        </p>
      </Section>

      <Section heading="7. Getting your data, or deleting it">
        <p>
          You can edit or delete your notes, uploads and posts yourself from inside the
          app at any time. For a copy of everything held about you, or for the account
          itself to be deleted, email{' '}
          <a className="underline" href="mailto:linhongsheng07@gmail.com">
            linhongsheng07@gmail.com
          </a>
          . That address reaches Kenny Lin, who built and runs the platform and is the
          only person with administrative access to it. Expect a reply within 30 days.
        </p>
      </Section>

      <Section heading="8. Age and school involvement">
        <p>
          This is a student project, not an official school system. It is built and run
          by a student at YKPao School, it is not operated, endorsed or supervised by the
          school, and the school holds no responsibility for it. Your schoolwork, grades
          and school records are not connected to it in any way.
        </p>
        <p>
          It is intended for students at the school, most of whom are under 18. If you are
          under 18, read this page with a parent or guardian before you register, and do
          not register if they object. A parent or guardian may ask for their child&apos;s
          account and data to be deleted using the address above, and it will be.
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
