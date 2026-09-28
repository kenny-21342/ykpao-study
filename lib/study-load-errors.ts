/**
 * What a student is told when the Study screen cannot load.
 *
 * Its own module, importing nothing, so the plain-node test runner can load it
 * — `app/components/StudyCoach.tsx` cannot be imported there. The same split
 * `lib/spend-cap.ts` and `lib/paper-template-shape.ts` use, and for the same
 * reason: the rule about what the student reads is worth testing properly, and
 * the fetch around it is not.
 */

/** One of the calls the Study screen makes, after it has come back. */
export type LoadSource = {
  /** What to call it in the message — the part of the screen it fills. */
  name: string;
  ok: boolean;
  status: number;
};

/**
 * The message for a failed load, or null when nothing failed.
 *
 * Every failure used to produce one fixed string, for three different calls,
 * so a 500 on reviews and a 401 on overview read identically and neither said
 * which one to go and look at. Naming the source and its status costs nothing
 * and is the difference between a report and a shrug.
 */
export function describeFailedSources(sources: readonly LoadSource[]): string | null {
  const failed = sources.filter((source) => !source.ok);
  if (failed.length === 0) return null;
  const detail = failed.map((source) => `${source.name} (${source.status})`).join(', ');
  return `Study data could not be loaded: ${detail}.`;
}
