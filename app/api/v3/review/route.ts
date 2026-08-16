import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { v3DisabledResponse, v3ErrorResponse } from "@/lib/v3/http";
import { searchV3ReviewIssues } from "@/lib/v3/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  maxConfidence: z.coerce.number().min(0).max(1).optional(),
});

export async function GET(request: Request) {
  const disabled = v3DisabledResponse();
  if (disabled) return disabled;
  if (!await requireAdmin()) return Response.json({ error: "Forbidden" }, { status: 403 });
  try {
    const url = new URL(request.url);
    const parsed = QuerySchema.parse({
      page: url.searchParams.get("page") ?? undefined,
      pageSize: url.searchParams.get("pageSize") ?? undefined,
      maxConfidence: url.searchParams.get("maxConfidence") ?? undefined,
    });
    return Response.json(await searchV3ReviewIssues({
      issueType: url.searchParams.get("issueType") || undefined,
      subjectId: url.searchParams.get("subject") || undefined,
      runId: url.searchParams.get("run") || undefined,
      ...parsed,
    }));
  } catch (error) {
    return v3ErrorResponse(error);
  }
}
