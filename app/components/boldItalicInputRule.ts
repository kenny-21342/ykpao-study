import { Extension, InputRule } from '@tiptap/core';

// StarterKit's default Bold/Italic input rules each require a non-`*`
// boundary immediately outside their delimiters, so `***text***` never
// matches either one (an adjacent extra `*` breaks both lookaheads).
// This mirrors `@tiptap/core`'s `markInputRule` but applies both marks
// to the same captured range in one step.
const starInputRegex = /(?:^|\s)(\*\*\*(?!\s+\*\*\*)((?:[^*]+))\*\*\*(?!\s+\*\*\*))$/;

export const BoldItalicInputRule = Extension.create({
  name: 'boldItalicInputRule',
  addInputRules() {
    const { schema } = this.editor.state;
    const boldType = schema.marks.bold;
    const italicType = schema.marks.italic;
    if (!boldType || !italicType) return [];

    return [
      new InputRule({
        find: starInputRegex,
        handler: ({ state, range, match }) => {
          const { tr } = state;
          const fullMatch = match[0];
          const captureGroup = match[2];
          if (!captureGroup) return null;

          const startSpaces = fullMatch.search(/\S/);
          const textStart = range.from + fullMatch.indexOf(captureGroup);
          const textEnd = textStart + captureGroup.length;

          if (textEnd < range.to) {
            tr.delete(textEnd, range.to);
          }
          if (textStart > range.from) {
            tr.delete(range.from + startSpaces, textStart);
          }

          const markStart = range.from + startSpaces;
          const markEnd = markStart + captureGroup.length;
          tr.addMark(markStart, markEnd, boldType.create());
          tr.addMark(markStart, markEnd, italicType.create());
          tr.removeStoredMark(boldType);
          tr.removeStoredMark(italicType);
        },
      }),
    ];
  },
});
