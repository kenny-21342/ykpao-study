/**
 * How the topic-mastery heatmap is organised.
 *
 * Pure and dependency-free so it can be unit-tested: the component it came
 * from is a client component importing React and lucide-react, which the bare
 * `node --experimental-strip-types` test runner cannot load.
 */

export type TopicRow = {
  key: string;
  subject: string;
  topic: string;
  total: number;
  correct: number;
  accuracy: number;
  mastery: number;
};

export type SubjectGroup = {
  subject: string;
  total: number;
  correct: number;
  accuracy: number;
  topics: TopicRow[];
};

/**
 * Topics grouped under their subject, weakest subject first and weakest topic
 * first inside each one.
 *
 * A subject's accuracy is recomputed from its own topic rows rather than taken
 * from `data.subjects`: the two are aggregated over different denominators in
 * the API (subjects count every attempt, topics only those that carry a topic),
 * so reading a heading off one list while its tiles come from the other can
 * show a subject at 80% above a block of red tiles.
 */
export function groupTopicsBySubject(topics: TopicRow[]): SubjectGroup[] {
  const groups = new Map<string, TopicRow[]>();
  for (const topic of topics) {
    const subject = topic.subject || 'Unspecified';
    const existing = groups.get(subject);
    if (existing) existing.push(topic);
    else groups.set(subject, [topic]);
  }
  return [...groups.entries()]
    .map(([subject, rows]) => {
      const total = rows.reduce((sum, row) => sum + row.total, 0);
      const correct = rows.reduce((sum, row) => sum + row.correct, 0);
      return {
        subject,
        total,
        correct,
        accuracy: total > 0 ? Math.round((correct / total) * 100) : 0,
        // Ties are broken by attempt count, then name: without a total order
        // the grid reshuffles between renders for the many topics that share
        // an accuracy, which is what made the flat list look arbitrary.
        topics: [...rows].sort(
          (a, b) => a.accuracy - b.accuracy || b.total - a.total || a.topic.localeCompare(b.topic),
        ),
      };
    })
    .sort((a, b) => a.accuracy - b.accuracy || b.total - a.total || a.subject.localeCompare(b.subject));
}
