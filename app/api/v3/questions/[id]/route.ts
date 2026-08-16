import { v3ErrorResponse, v3GuardResponse } from "@/lib/v3/http";
import { getV3Question } from "@/lib/v3/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const disabled = await v3GuardResponse();
  if (disabled) return disabled;
  try {
    const { id } = await params;
    const question = await getV3Question(id);
    return question ? Response.json(question) : Response.json({ error: "Question not found" }, { status: 404 });
  } catch (error) {
    return v3ErrorResponse(error);
  }
}
