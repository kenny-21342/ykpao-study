import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { V3Shell } from "../components/V3Shell";
import { ReviewQueueV3 } from "../components/ReviewQueueV3";

export default async function V3ReviewPage() {
  if (!await requireAdmin()) redirect("/?admin=forbidden");
  return <V3Shell active="review"><ReviewQueueV3 /></V3Shell>;
}
