import AppChrome from '@/app/components/AppChrome';

export default function BankLayout({ children }: { children: React.ReactNode }) {
  return <AppChrome active="practice">{children}</AppChrome>;
}
