import { createHash } from "node:crypto";
import { getV3Config } from "@/lib/v3/config";
import { getV3Prisma } from "@/lib/v3/db";
import { v3ErrorResponse, v3GuardResponse } from "@/lib/v3/http";
import { getV3AssetStore } from "@/lib/v3/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ assetId: string }> }) {
  const disabled = await v3GuardResponse();
  if (disabled) return disabled;
  try {
    const { assetId } = await params;
    if (!/^v3a_[a-f0-9]{24}$/.test(assetId)) return Response.json({ error: "Asset not found" }, { status: 404 });
    const asset = await getV3Prisma().v3Asset.findUnique({ where: { id: assetId } });
    if (!asset) return Response.json({ error: "Asset not found" }, { status: 404 });
    const store = await getV3AssetStore(getV3Config().assetRoot);
    const bytes = await store.read(asset.relativePath);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== asset.sha256) return Response.json({ error: "Asset integrity check failed" }, { status: 500 });
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": asset.mimeType,
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "private, max-age=31536000, immutable",
        ETag: `"${asset.sha256}"`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return v3ErrorResponse(error);
  }
}
