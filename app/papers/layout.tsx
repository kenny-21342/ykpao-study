import AppChrome from '@/app/components/AppChrome';

export default function PapersLayout({ children }: { children: React.ReactNode }) {
  return <AppChrome active="papers">{children}</AppChrome>;
}
