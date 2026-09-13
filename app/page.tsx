import type { Metadata } from 'next';
import { getSessionUser } from '@/lib/auth';
import { appOrigin } from '@/lib/email';
import LandingPage from './components/LandingPage';
import HomeShell from './components/HomeShell';

/**
 * `/` is two different pages, and which one you get is decided on the server.
 *
 * It used to be one `'use client'` shell that branched on `useSession()`.
 * That meant a signed-out visitor -- including every link preview, every
 * crawler, and anyone opening a shared link for the first time -- received a
 * document with no content in it and had to run the whole app bundle to find
 * out what the site was. Deciding here instead means a guest gets real,
 * server-rendered HTML, and a signed-in student gets the app with no flash of
 * marketing copy in between.
 *
 * `getSessionUser` rather than a bare session check: it is the same chokepoint
 * every route uses, so a banned user or one whose session was revoked by a
 * password change lands on the public page instead of an app shell in which
 * every request would 401.
 */
export const metadata: Metadata = {
  title: 'YKPao Study — past papers, already cut into questions',
  description:
    'A revision platform built around the IGCSE and A-level archive: every question separated from its paper, paired with its mark scheme, and ready to practise, mark and come back to.',
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    siteName: 'YKPao Study',
    title: 'YKPao Study — past papers, already cut into questions',
    description:
      'Practise real exam questions, get written answers marked against the mark scheme, and revisit what you got wrong on a spaced schedule.',
    url: appOrigin(),
    images: [{ url: '/icon-192.png', width: 192, height: 192, alt: 'YKPao Study' }],
  },
  twitter: {
    card: 'summary',
    title: 'YKPao Study — past papers, already cut into questions',
    description:
      'Practise real exam questions, get written answers marked against the mark scheme, and revisit what you got wrong on a spaced schedule.',
  },
};

export default async function Home() {
  const user = await getSessionUser();
  return user ? <HomeShell /> : <LandingPage />;
}
