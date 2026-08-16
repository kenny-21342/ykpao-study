'use client';

import { useEffect, useState } from 'react';

/**
 * Returns `value` after it has stopped changing for `delayMs`.
 *
 * Search boxes here were wired straight into the fetch dependency array, so
 * typing "biology" fired seven requests, each of which replaced the results
 * with a loading state — the list flickered and the answer that finally landed
 * was whichever response happened to arrive last, not necessarily the one for
 * the current query.
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
