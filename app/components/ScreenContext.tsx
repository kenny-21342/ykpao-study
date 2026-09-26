'use client';

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

import {
  DEFAULT_SCREEN_CONTEXT,
  serializeScreenContext,
  type ScreenContext,
} from '@/lib/screen-context';

export type { ScreenContext };

/**
 * Structured screen context — what the student is actually doing right now.
 *
 * Instead of scraping DOM text (which includes nav/sidebar noise), each major
 * component updates this context object when its state changes. The
 * FloatingAIAssistant reads it to know exactly what the student is looking at.
 */


const DEFAULT_CONTEXT: ScreenContext = { ...DEFAULT_SCREEN_CONTEXT, updatedAt: Date.now() };

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

  const toPromptString = useCallback(() => serializeScreenContext(context), [context]);

  return (
    <ScreenContextContext.Provider value={{ context, update, updateData, toPromptString }}>
      {children}
    </ScreenContextContext.Provider>
  );
}

// One frozen fallback, not a fresh object per render.
//
// Built once at module scope because a component outside the provider --
// `PaperViewer` at /papers/[id] is the live case -- otherwise receives new
// function identities on every render. Any effect that lists `update` or
// `updateData` in its dependencies then re-runs forever, which is why the
// existing call site had to suppress `react-hooks/exhaustive-deps` to stay
// correct. With a stable value the dependency is honest and the suppression is
// no longer the price of it.
const NO_OP_CONTEXT: ScreenContextValue = {
  context: DEFAULT_CONTEXT,
  update: () => {},
  updateData: () => {},
  toPromptString: () => '',
};

export function useScreenContext() {
  return useContext(ScreenContextContext) ?? NO_OP_CONTEXT;
}
