import { ZodError } from "zod";
import { isV3Enabled } from "@/lib/v3/config";
import { requireAdmin } from "@/lib/auth";

export function v3DisabledResponse(): Response | null {
  return isV3Enabled() ? null : Response.json({ error: "V3 is disabled" }, { status: 404 });
}

/**
 * Gate for every V3 read endpoint: returns a `Response` to short-circuit
 * with, or `null` when the caller may proceed.
 *
 * V3 is normally off in production (see `isV3Enabled`), but it exposes the
 * whole question corpus and its binary assets, so it must not be readable by
 * anonymous callers even in the environments where it is switched on.
 *
 * The bar is **admin**, not merely signed-in: `/v3` is an internal corpus tool
 * and its pages are gated by `requireAdmin()` in `app/v3/layout.tsx`. A weaker
 * check here left the whole corpus and every binary asset readable by any
 * ordinary student account that guessed the URL — a page-level gate with open
 * API routes underneath is not a gate. Every `/v3` page fetches through these
 * handlers only, so nothing non-admin depends on the looser rule.
 */
export async function v3GuardResponse(): Promise<Response | null> {
  const disabled = v3DisabledResponse();
  if (disabled) return disabled;

  const admin = await requireAdmin();
  if (!admin) return Response.json({ error: "Forbidden" }, { status: 403 });

  return null;
}

export function v3ErrorResponse(error: unknown): Response {
  if (error instanceof ZodError) {
    return Response.json({ error: "Invalid request", issues: error.issues }, { status: 400 });
  }
  console.error("V3 request failed", error instanceof Error ? error.message : error);
  return Response.json({ error: "The local V3 corpus is unavailable" }, { status: 503 });
}

export function listParameter(searchParams: URLSearchParams, key: string): string[] | undefined {
  const values = searchParams.getAll(key).flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
  return values.length ? [...new Set(values)] : undefined;
}
