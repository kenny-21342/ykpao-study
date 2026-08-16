import { z } from "zod";
import { listParameter, v3ErrorResponse, v3GuardResponse } from "@/lib/v3/http";
import { searchV3Questions } from "@/lib/v3/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PaginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export async function GET(request: Request) {
  const disabled = await v3GuardResponse();
  if (disabled) return disabled;
  try {
    const url = new URL(request.url);
    const pagination = PaginationSchema.parse({
      page: url.searchParams.get("page") ?? undefined,
      pageSize: url.searchParams.get("pageSize") ?? undefined,
    });
    return Response.json(await searchV3Questions({
      query: url.searchParams.get("q")?.trim() || undefined,
      boards: listParameter(url.searchParams, "board"),
      qualifications: listParameter(url.searchParams, "qualification"),
      levels: listParameter(url.searchParams, "level"),
      subjects: listParameter(url.searchParams, "subject"),
      years: listParameter(url.searchParams, "year")?.map(Number).filter(Number.isInteger),
      sessions: listParameter(url.searchParams, "session"),
      paperTypes: listParameter(url.searchParams, "paperType"),
      variants: listParameter(url.searchParams, "variant"),
      timezones: listParameter(url.searchParams, "timezone"),
      tags: listParameter(url.searchParams, "tag"),
      topics: listParameter(url.searchParams, "topic"),
      ...pagination,
    }));
  } catch (error) {
    return v3ErrorResponse(error);
  }
}
