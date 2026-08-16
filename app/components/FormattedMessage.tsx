'use client';

import { useMemo } from 'react';
import 'katex/dist/katex.min.css';
import { renderMarkdownWithMath } from '@/lib/latex';
import { sanitizeHtml } from '@/lib/sanitize-html';

type FormattedMessageProps = {
  content: string;
};

export default function FormattedMessage({ content }: FormattedMessageProps) {
  // `marked` passes raw HTML in the source straight through, so the rendered
  // output is untrusted even though the input is "just markdown".
  const rendered = useMemo(
    () => sanitizeHtml(renderMarkdownWithMath(content ?? '')),
    [content],
  );

  return (
    <div className="formatted-message" style={{ lineHeight: '1.6' }} dangerouslySetInnerHTML={{ __html: rendered }} />
  );
}
