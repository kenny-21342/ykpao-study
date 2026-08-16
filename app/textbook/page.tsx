import { redirect } from 'next/navigation';

export default function TextbookPage() {
  redirect('/?tab=materials');
}
