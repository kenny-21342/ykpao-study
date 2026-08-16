import { redirect } from 'next/navigation';

/**
 * The notebook lives inside the Materials tab of the app shell, which is what
 * provides the sidebar, theme toggle, and a way back out.
 *
 * This route used to render the component standalone *as well*, so anyone
 * following a direct link landed in a bare notebook with no navigation at all
 * — while /notes and /textbook already redirected here. The component now
 * lives in app/components/NotesTextbook.tsx and this route redirects like its
 * two siblings.
 */
export default function NotesTextbookPage() {
  redirect('/?tab=materials');
}
