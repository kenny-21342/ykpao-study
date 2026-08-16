import { redirect } from 'next/navigation';

export default function NotesPage() {
  redirect('/?tab=materials');
}
