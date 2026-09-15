import AppChrome from '@/app/components/AppChrome';

export default function UsageLayout({ children }: { children: React.ReactNode }) {
  return <AppChrome active={null}>{children}</AppChrome>;
}
