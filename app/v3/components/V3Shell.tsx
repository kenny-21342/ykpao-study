import Link from "next/link";
import { ClipboardCheck, Database, Home } from "lucide-react";

export function V3Shell({ children, active }: { children: React.ReactNode; active: "questions" | "review" }) {
  return (
    <div className="v3-shell">
      <header className="v3-header">
        <Link href="/v3/questions" className="v3-brand" aria-label="V3 question corpus">
          <span className="v3-brand-icon"><Database aria-hidden="true" /></span>
          <span><strong>Question Corpus</strong><small>V3 local</small></span>
        </Link>
        <nav aria-label="V3 navigation" className="v3-nav">
          <Link href="/v3/questions" data-active={active === "questions"}>Questions</Link>
          <Link href="/v3/review" data-active={active === "review"}><ClipboardCheck aria-hidden="true" />Review</Link>
        </nav>
        <Link href="/" className="v3-icon-link" title="Back to app" aria-label="Back to app"><Home aria-hidden="true" /></Link>
      </header>
      {children}
    </div>
  );
}
