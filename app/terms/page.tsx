import type { Metadata } from 'next';
import { LegalPage, Section } from '@/app/components/LegalPage';

export const metadata: Metadata = {
  title: 'Terms — YKPao Study',
  description: 'The rules for using YKPao Study, and what it does and does not promise.',
};

/**
 * Drafted alongside app/privacy/page.tsx. The same rule applies: every factual
 * claim is checkable in the repository, and everything that is a decision
 * rather than a fact was left to the operator; those decisions have since been
 * made and written in, so nothing here is marked REVIEW any more.
 *
 * Section 6 is the one that is genuinely load-bearing and genuinely true: the
 * corpus is copyrighted exam material, and the platform's own preview banners
 * (lib/feature-readiness.ts) already say the marking is unfinished.
 */
export default function TermsOfService() {
  return (
    <LegalPage title="Terms of use" updated="26 September 2026">
      <Section heading="The short version">
        <p>
          Use it to study. Do not use it to cheat, to harass anyone, or to scrape the
          question archive. It is a student project offered as-is, so do not treat its
          marking as authoritative.
        </p>
      </Section>

      <Section heading="1. Who can use it">
        <p>
          Accounts are for students and staff at YKPao School. You do not need a school
          email address to register — a personal one works — but the platform is built for
          that one school, and accounts that clearly belong to nobody there may be removed.
        </p>
        <p>
          Leaving the school does not close your account automatically. You keep it, and
          your work, until you ask for it to be deleted; the operator may also close an
          account that has gone unused for a long time, after warning the address on it.
        </p>
        <p>
          You must confirm your email address before you can sign in, and you must give
          real details when you register. One account per person; do not share your
          password or sign in as anyone else.
        </p>
      </Section>

      <Section heading="2. What you may not do">
        <ul>
          <li>
            Submit another student&apos;s work as your own, or use the platform in a way
            your teachers have told you not to for assessed work.
          </li>
          <li>
            Bulk-download, scrape or redistribute the question archive, the crops, or the
            mark schemes.
          </li>
          <li>
            Post anything abusive, harassing or illegal to the discussion board or to
            shared notes, or upload content you do not have the right to share.
          </li>
          <li>
            Try to reach other people&apos;s notes, attempts or account data, probe the
            platform for weaknesses, or work around its rate limits.
          </li>
          <li>Use an AI key you are not entitled to use.</li>
        </ul>
        <p>
          Accounts that do these things can be suspended, which takes effect immediately
          and everywhere.
        </p>
      </Section>

      <Section heading="3. Your work stays yours">
        <p>
          You keep ownership of the notes, answers, drawings and files you put into the
          platform. You grant the platform only the permission it needs to store and
          display them back to you, and to show them to anyone you deliberately share
          them with. Nothing you write is published elsewhere or used to train anything by
          this platform.
        </p>
      </Section>

      <Section heading="4. AI marking and your own key">
        <p>
          The AI features are optional and are off until a key is available for your
          account. Adding your own key means requests made on your behalf are billed to
          you by that provider — this platform does not charge you and does not cover
          those costs. The Usage page shows what has been spent so you can check it
          against your provider&apos;s bill; it is an estimate, not an invoice.
        </p>
        <p>
          Read section 4 of the{' '}
          <a href="/privacy">privacy notice</a> before using these features: your answers
          are sent to a third party.
        </p>
      </Section>

      <Section heading="5. Exam material">
        <p>
          Past papers and mark schemes remain the copyright of the examination boards that
          wrote them. They are reproduced here for personal revision. Nothing on this
          platform is endorsed by, affiliated with or approved by any examination board.
        </p>
      </Section>

      <Section heading="6. No guarantees">
        <p>
          This is a student-built project offered as-is. Marking is generated
          automatically and is regularly wrong; a mark it gives you is a study aid, not a
          grade, and it is not a prediction of what a real examiner would award. Parts of
          the platform are explicitly unfinished and say so where you meet them. Papers
          generated by the mock-exam tool are not modelled on the structure of a real
          paper.
        </p>
        <p>
          Keep your own copy of anything you would be upset to lose. The platform is not
          liable for lost work, for a mark it got wrong, or for time spent revising the
          wrong thing.
        </p>
      </Section>

      <Section heading="7. Availability">
        <p>
          The platform may be unavailable, may change, and may be withdrawn. It is run by
          one student, on paid infrastructure, with no service guarantee: expect occasional
          downtime, and expect features to appear and disappear.
        </p>
        <p>
          If it is going to be shut down for good, a notice will appear on the site and be
          sent to the address on your account at least 30 days beforehand. There is no
          one-click export, so within that window ask at the address below and you will be
          sent a copy of your own notes, attempts and uploads. Unplanned outages get no
          notice, because nobody has any.
        </p>
      </Section>

      <Section heading="8. Questions and disputes">
        <p>
          Questions, complaints and requests about your data all go to{' '}
          <a className="underline" href="mailto:linhongsheng07@gmail.com">
            linhongsheng07@gmail.com
          </a>
          , which reaches Kenny Lin, who built and runs the platform. Raise a problem there
          first — most of them are bugs, and a bug gets fixed faster than it gets argued
          about.
        </p>
        <p>
          This is not a school system, so the school&apos;s complaints procedures do not
          cover it, and there is no appeals body above the operator. These terms are
          governed by the laws of the People&apos;s Republic of China, and anything that
          cannot be settled directly belongs to the courts of Shanghai. Nothing here limits
          a right you hold under law that cannot be waived by agreement.
        </p>
      </Section>
    </LegalPage>
  );
}
