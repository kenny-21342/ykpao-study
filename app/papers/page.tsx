import PaperBrowser from '@/app/components/PaperBrowser';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Past Papers',
};

export default function PapersPage() {
  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="mx-auto max-w-6xl">
        <PaperBrowser />
      </div>
    </main>
  );
}
