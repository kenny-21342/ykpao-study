import AppChrome from '@/app/components/AppChrome';

export default function AccountLayout({ children }: { children: React.ReactNode }) {
  return <AppChrome active={null}>{children}</AppChrome>;
}
