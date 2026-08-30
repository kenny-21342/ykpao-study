import { notFound } from 'next/navigation';
import PaperViewer from '@/app/components/PaperViewer';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Past Paper',
};

export default async function PaperPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const paperId = Number.parseInt(id, 10);

  if (!Number.isInteger(paperId) || paperId <= 0) {
    notFound();
  }

  return (
    <main className="min-h-full">
      <PaperViewer paperId={paperId} />
    </main>
  );
}
