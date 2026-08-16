import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import "katex/dist/katex.min.css";
import "./v3.css";

export const dynamic = "force-dynamic";

/**
 * The /v3 segment is an internal corpus-review tool, not a student surface: it
 * is self-branded "Question Corpus / V3 local" and duplicates Practice against
 * a second, inconsistent question bank. It was publicly reachable and
 * unauthenticated. Gate the whole segment the way app/v3/review/page.tsx
 * already gated itself, rather than leaving a parallel unauthenticated app
 * serving the corpus.
 */
export default async function V3Layout({ children }: { children: React.ReactNode }) {
  const admin = await requireAdmin();
  if (!admin) redirect("/?admin=forbidden");

  return <div className="v3-root">{children}</div>;
}
