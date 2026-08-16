'use client';

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

/**
 * Structured screen context — what the student is actually doing right now.
 *
 * Instead of scraping DOM text (which includes nav/sidebar noise), each major
 * component updates this context object when its state changes. The
 * FloatingAIAssistant reads it to know exactly what the student is looking at.
 */

export type ScreenContext = {
  // Which section of the app is active
  tab: string;
  // Human-readable description of what the student is viewing
  description: string;
  // Structured data depending on context (flexible)
  data: {
    // Practice
    questionId?: number;
    questionCode?: string;       // e.g. "0610-S24-P42-Q1"
    questionTopic?: string;      // e.g. "B5.1 Plant nutrition"
    questionSubject?: string;    // e.g. "Biology"
    questionText?: string;       // first 500 chars of the question content
    questionMarks?: number;

    // Notes
    noteId?: string;
    noteTitle?: string;
    noteContent?: string;
    noteSelection?: string;

    // Practice / exam
    practiceMode?: 'browse' | 'practice';
    recentAttemptScore?: number | null;

    // Weakness heatmap
    weakestTopic?: string;

    // General
    courseId?: string;           // enrolled Course.id for server-side validation
    subjectCode?: string;        // e.g. "0610" — used for RAG filtering
  };
  // Timestamp of last update (so the AI knows how fresh the context is)
  updatedAt: number;
};

const DEFAULT_CONTEXT: ScreenContext = {
  tab: 'dashboard',
  description: 'Viewing the dashboard',
  data: {},
  updatedAt: Date.now(),
};

type ScreenContextValue = {
  context: ScreenContext;
  update: (partial: Partial<ScreenContext>) => void;
  updateData: (partial: Partial<ScreenContext['data']>) => void;
  // Serialise to a compact string for the AI prompt
  toPromptString: () => string;
};

const ScreenContextContext = createContext<ScreenContextValue | null>(null);

export function ScreenContextProvider({ children }: { children: ReactNode }) {
  const [context, setContext] = useState<ScreenContext>(DEFAULT_CONTEXT);

  const update = useCallback((partial: Partial<ScreenContext>) => {
    setContext((prev) => ({
      ...prev,
      ...partial,
      data: partial.data ? { ...prev.data, ...partial.data } : prev.data,
      updatedAt: Date.now(),
    }));
  }, []);

  const updateData = useCallback((partial: Partial<ScreenContext['data']>) => {
    setContext((prev) => ({
      ...prev,
      data: { ...prev.data, ...partial },
      updatedAt: Date.now(),
    }));
  }, []);

  const toPromptString = useCallback(() => {
    const d = context.data;
    const parts: string[] = [];

    parts.push(`Section: ${context.description}`);

    if (d.questionCode) {
      parts.push(`Viewing question: ${d.questionCode} (${d.questionSubject ?? 'Unknown subject'})`);
      if (d.questionTopic) parts.push(`Topic: ${d.questionTopic}`);
      if (d.questionMarks) parts.push(`Marks: ${d.questionMarks}`);
      if (d.questionText) parts.push(`Question text: ${d.questionText}`);
      if (d.practiceMode === 'practice') parts.push(`The student is in practice mode and writing an answer.`);
    }

    if (d.noteTitle) {
      parts.push(`Viewing note: "${d.noteTitle}"`);
      if (d.noteSelection) parts.push(`Selected note text: ${d.noteSelection}`);
      if (d.noteContent) parts.push(`Note content: ${d.noteContent}`);
    }

    if (d.weakestTopic) {
      parts.push(`The student's weakest topic is: ${d.weakestTopic}`);
    }

    if (d.subjectCode) {
      parts.push(`Subject: ${d.subjectCode}`);
    }

    return parts.join('\n');
  }, [context]);

  return (
    <ScreenContextContext.Provider value={{ context, update, updateData, toPromptString }}>
      {children}
    </ScreenContextContext.Provider>
  );
}

export function useScreenContext() {
  const ctx = useContext(ScreenContextContext);
  if (!ctx) {
    // Fallback for components outside the provider — return a no-op context.
    return {
      context: DEFAULT_CONTEXT,
      update: () => {},
      updateData: () => {},
      toPromptString: () => '',
    };
  }
  return ctx;
}
