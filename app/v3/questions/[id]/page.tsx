import { V3Shell } from "../../components/V3Shell";
import { QuestionDetailV3 } from "../../components/QuestionDetailV3";

export default async function V3QuestionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <V3Shell active="questions"><QuestionDetailV3 id={id} /></V3Shell>;
}
