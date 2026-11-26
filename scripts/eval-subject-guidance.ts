/**
 * Before/after check for lib/subject-guidance.ts.
 *
 *   npx tsx --env-file=.env scripts/eval-subject-guidance.ts USER_ID OUT_DIR QID [QID ...]
 *
 * For each bank question: has the model write a middling student answer, then
 * grades it twice -- with the plain grader prompt and with the subject
 * guidance appended -- and writes both results to OUT_DIR/<qid>.md for a
 * side-by-side read. Spends real tokens on USER_ID's AI allowance source.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { prisma } from '../lib/prisma';
import { chat, parseJsonReply, SYSTEM_PROMPTS } from '../lib/ai';
import { requireTextAi } from '../lib/ai-credentials';
import { graderGuidance, graderMaxTokens, graderNoThinking, nearestExemplar } from '../lib/subject-guidance';
import type { GradeResult } from '../types/ai';

async function main() {
  const [userId, outDir, ...ids] = process.argv.slice(2);
  if (!userId || !outDir || !ids.length) throw new Error('usage: USER_ID OUT_DIR QID...');
  mkdirSync(outDir, { recursive: true });
  const access = await requireTextAi(userId);
  if (!access.ok) throw new Error(access.error);
  const credential = access.credential;

  await Promise.all(ids.map(async (id) => {
    const q = await prisma.bankQuestion.findUniqueOrThrow({
      where: { id: Number(id) },
      include: { markScheme: true, paper: { include: { subject: true } } },
    });
    const marks = q.markScheme?.totalMarks ?? q.totalMarks ?? 0;
    const subject = `ib-${q.paper.subject.code}`;
    const ms = q.markScheme?.answerMd ?? '';

    const student = await chat(
      [{
        role: 'user',
        content: `Write a realistic answer by an average IB Economics student to the exam question below -- one that would score about half marks: some correct theory, a diagram mentioned but only loosely explained, vague or generic examples, thin evaluation. Plain text only, no commentary.\n\n${q.bodyMd}`,
      }],
      { credential, temperature: 0.7, maxTokens: 4000 },
    );

    const user = `Grade the student's answer against the markscheme.\n\nQuestion:\n${q.bodyMd}\n\nMarkscheme:\n${ms}\n\nTotal marks: ${marks}\n\nStudent answer:\n${student}`;
    const noThinking = process.env.EVAL_NO_THINKING === '1' || graderNoThinking({ subject, marks });
    const run = async (system: string, maxTokens: number, tag: string) => {
      const messages = [{ role: 'system' as const, content: system }, { role: 'user' as const, content: user }];
      const raw = await chat(messages, { credential, temperature: 0.2, maxTokens, budgetMs: 240_000, noThinking, jsonResponse: true }).catch((e) => String(e));
      try {
        return parseJsonReply<GradeResult>(raw);
      } catch (err) {
        // Keep the raw reply so a parse failure can be read, not guessed at.
        writeFileSync(path.join(outDir, `${id}-${tag}.raw.txt`), raw);
        return { error: String(err) } as unknown as GradeResult;
      }
    };

    const guidance = graderGuidance({ subject, marks, questionText: q.bodyMd });
    const [before, after] = await Promise.all([
      run(SYSTEM_PROMPTS.grader, Number(process.env.EVAL_BEFORE_TOKENS ?? 1200), 'before'),
      run(SYSTEM_PROMPTS.grader + guidance, graderMaxTokens({ subject, marks }, 1200), 'after'),
    ]);
    const words = (s: unknown) => String(s ?? '').split(/\s+/).filter(Boolean).length;
    const section = (label: string, g: GradeResult) =>
      `## ${label}\n\nscore ${g.score}/${g.maxScore} -- model answer ${words(g.modelAnswer)} words\n\n` +
      `**Weaknesses**\n${(g.weaknesses ?? []).map((w) => `- ${w}`).join('\n')}\n\n` +
      `**Model answer**\n\n${g.modelAnswer ?? JSON.stringify(g)}\n`;
    writeFileSync(
      path.join(outDir, `${id}.md`),
      `# ${id} (${q.paper.subject.level} P${q.paper.paperNumber} ${q.paper.year})\n\n${q.bodyMd}\n\n` +
        `exemplar: ${nearestExemplar(q.bodyMd)?.question ?? '(none)'}\n\n` +
        `## Student answer\n\n${student}\n\n${section('BEFORE', before)}\n${section('AFTER', after)}`,
    );
    console.log(id, 'before', before.score, words(before.modelAnswer), 'words | after', after.score, words(after.modelAnswer), 'words');
  }));
  await prisma.$disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
