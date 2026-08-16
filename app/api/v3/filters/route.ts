import { v3ErrorResponse, v3GuardResponse } from "@/lib/v3/http";
import { getV3FilterMetadata } from "@/lib/v3/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const disabled = await v3GuardResponse();
  if (disabled) return disabled;
  try {
    return Response.json(await getV3FilterMetadata());
  } catch (error) {
    return v3ErrorResponse(error);
  }
}
