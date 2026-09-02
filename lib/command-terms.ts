/**
 * Command terms -- the verb a question is actually asking you to perform.
 *
 * "Evaluate" and "describe" are marked against different criteria in every IB
 * and CAIE mark scheme, and answering one as if it said the other is the most
 * common avoidable way a prepared student loses marks. Nothing in the product
 * showed a student which term a question used, let alone how they score by
 * term.
 *
 * The set and the extractor are a direct port of `extract_command_words` and
 * `COMMAND_WORDS` in `pdf_extraction/bank/tag.py`, which has computed these
 * since stage 4 was written and then discarded them -- there was no column.
 * Because the function is pure text matching, the whole 66,758-question
 * published corpus can be tagged with no model call at all.
 *
 * Kept free of any database import so it can be unit-tested directly and
 * imported from both the backfill script and the client.
 *
 * `tests/command-terms.test.ts` asserts this list matches tag.py's, so the two
 * cannot drift silently.
 */

/** What each term demands, and the shape of an answer that earns the marks. */
export type CommandTerm = {
  slug: string;
  label: string;
  /** Recall | procedure | higher -- the level of demand the term signals. */
  band: 'recall' | 'procedure' | 'higher';
  /** One line a student can act on, phrased as the marker sees it. */
  guidance: string;
};

export const COMMAND_TERMS: readonly CommandTerm[] = [
  // Recall / direct. Marks are for the item itself; working earns nothing.
  { slug: 'state', label: 'State', band: 'recall', guidance: 'Give the answer only. No working, no justification -- extra prose earns nothing and can contradict a correct answer.' },
  { slug: 'write', label: 'Write', band: 'recall', guidance: 'Produce the required form exactly as asked. Marks are for the form, not the reasoning.' },
  { slug: 'list', label: 'List', band: 'recall', guidance: 'Give the number of items asked for, as separate points. A list of six when three are asked is marked on the first three.' },
  { slug: 'name', label: 'Name', band: 'recall', guidance: 'Give the accepted term. A description of the thing does not earn the mark if the name is missing.' },
  { slug: 'give', label: 'Give', band: 'recall', guidance: 'State the answer without working, at the precision the question asks for.' },
  { slug: 'identify', label: 'Identify', band: 'recall', guidance: 'Pick out and name the feature. Say which one, not what it does.' },
  { slug: 'define', label: 'Define', band: 'recall', guidance: 'Give the precise meaning. Mark schemes reward specific words -- an approximate paraphrase often scores zero.' },
  { slug: 'label', label: 'Label', band: 'recall', guidance: 'Annotate the diagram itself. Marks sit on the diagram, not on prose beside it.' },

  // Routine procedure. Method marks are available independently of the answer.
  { slug: 'calculate', label: 'Calculate', band: 'procedure', guidance: 'Show the working. Method marks stand even when the final number is wrong; a bare answer forfeits them.' },
  { slug: 'find', label: 'Find', band: 'procedure', guidance: 'Obtain the value or expression and show enough working for the method to be credited.' },
  { slug: 'determine', label: 'Determine', band: 'procedure', guidance: 'Reach the answer from the given data, showing the steps that got you there.' },
  { slug: 'solve', label: 'Solve', band: 'procedure', guidance: 'Give every solution in the stated range, not just the first one found.' },
  { slug: 'show', label: 'Show', band: 'procedure', guidance: 'The answer is printed in the question, so the marks are entirely in the steps. Do not skip a line, and do not work backwards from the result.' },
  { slug: 'evaluate', label: 'Evaluate', band: 'higher', guidance: 'In Maths: compute the value. In essay subjects: weigh evidence on both sides and reach a judgement -- a one-sided answer caps the mark however detailed it is.' },
  { slug: 'simplify', label: 'Simplify', band: 'procedure', guidance: 'Reduce to lowest terms. An unsimplified but correct expression usually loses the final mark.' },
  { slug: 'expand', label: 'Expand', band: 'procedure', guidance: 'Multiply out fully and collect like terms.' },
  { slug: 'factorise', label: 'Factorise', band: 'procedure', guidance: 'Factor completely. A partial factorisation loses the last mark.' },
  { slug: 'factorize', label: 'Factorize', band: 'procedure', guidance: 'Factor completely. A partial factorisation loses the last mark.' },
  { slug: 'plot', label: 'Plot', band: 'procedure', guidance: 'Mark the given points accurately on the axes provided; accuracy is marked to the grid.' },
  { slug: 'sketch', label: 'Sketch', band: 'procedure', guidance: 'Shape and key features -- intercepts, asymptotes, turning points -- not accurate plotting.' },
  { slug: 'draw', label: 'Draw', band: 'procedure', guidance: 'Produce an accurate drawing with a ruler and correct scale, unlike a sketch.' },
  { slug: 'complete', label: 'Complete', band: 'procedure', guidance: 'Fill in the given table, diagram or statement. Answer on the printed structure.' },
  { slug: 'convert', label: 'Convert', band: 'procedure', guidance: 'Change to the stated unit or form, and state the unit in the answer.' },
  { slug: 'estimate', label: 'Estimate', band: 'procedure', guidance: 'Give an approximate value obtained by a stated method -- the method is what is marked.' },
  { slug: 'measure', label: 'Measure', band: 'procedure', guidance: 'Read the value from the diagram or instrument to the stated precision, with units.' },

  // Higher demand. Structure, not length, earns the marks here.
  { slug: 'prove', label: 'Prove', band: 'higher', guidance: 'Every step must follow with justification. A worked example is not a proof.' },
  { slug: 'derive', label: 'Derive', band: 'higher', guidance: 'Start from a stated principle or standard result and reach the expression by argument.' },
  { slug: 'justify', label: 'Justify', band: 'higher', guidance: 'Give the reason your answer holds, tied to evidence or a principle. The claim alone earns nothing.' },
  { slug: 'explain', label: 'Explain', band: 'higher', guidance: 'Give reasons or causes -- "because ...". Stating what happens is a description and scores under half.' },
  { slug: 'describe', label: 'Describe', band: 'higher', guidance: 'Say what happens in detail. No reasons required -- and no marks for them.' },
  { slug: 'compare', label: 'Compare', band: 'higher', guidance: 'Make explicit linked points about both things ("X is larger than Y, whereas ..."). Two separate paragraphs do not earn comparison marks.' },
  { slug: 'analyse', label: 'Analyse', band: 'higher', guidance: 'Break into parts and show how they relate. Structure carries the marks, not the amount written.' },
  { slug: 'analyze', label: 'Analyze', band: 'higher', guidance: 'Break into parts and show how they relate. Structure carries the marks, not the amount written.' },
  { slug: 'discuss', label: 'Discuss', band: 'higher', guidance: 'Present more than one position with supporting evidence before concluding.' },
  { slug: 'criticise', label: 'Criticise', band: 'higher', guidance: 'Give a reasoned appraisal of strengths and weaknesses, not only faults.' },
  { slug: 'criticize', label: 'Criticize', band: 'higher', guidance: 'Give a reasoned appraisal of strengths and weaknesses, not only faults.' },
  { slug: 'assess', label: 'Assess', band: 'higher', guidance: 'Judge the importance or value of something, with the reasoning that supports the judgement.' },
  { slug: 'verify', label: 'Verify', band: 'higher', guidance: 'Substitute or test to confirm the stated result holds, and say that it does.' },
  { slug: 'deduce', label: 'Deduce', band: 'higher', guidance: 'Reach a conclusion from the information given, naming what you used.' },
  { slug: 'suggest', label: 'Suggest', band: 'higher', guidance: 'Apply what you know to an unfamiliar situation. There is usually no single right answer, so the reasoning is what is marked.' },
  { slug: 'comment', label: 'Comment', band: 'higher', guidance: 'Give an informed opinion on what the data or result shows, in context.' },
  { slug: 'interpret', label: 'Interpret', band: 'higher', guidance: 'Say what the result means in the context of the question, not what it is.' },
];

const BY_SLUG = new Map(COMMAND_TERMS.map((term) => [term.slug, term]));

/** The slug set, matching `COMMAND_WORDS` in tag.py. */
export const COMMAND_TERM_SLUGS: ReadonlySet<string> = new Set(BY_SLUG.keys());

export function commandTerm(slug: string): CommandTerm | null {
  return BY_SLUG.get(slug.trim().toLowerCase()) ?? null;
}

export function commandTermLabel(slug: string): string {
  return commandTerm(slug)?.label ?? slug;
}

/**
 * The command terms present in a question, in order of first appearance.
 *
 * A direct port of `extract_command_words`: same word regex, same casefold,
 * same de-duplication, same ordering. Ported rather than shared because the
 * pipeline is Python and the app is TypeScript; the test pins them together.
 */
export function extractCommandTerms(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of (text || '').toLowerCase().matchAll(/\b[a-z]+\b/g)) {
    const word = match[0];
    if (COMMAND_TERM_SLUGS.has(word) && !seen.has(word)) {
      found.push(word);
      seen.add(word);
    }
  }
  return found;
}
