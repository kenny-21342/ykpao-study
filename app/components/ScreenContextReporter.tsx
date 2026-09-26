'use client';

/**
 * Report screen context from a server component.
 *
 * `ScreenContext` is a client context, so a server-rendered page cannot call
 * `updateData` itself. Rather than converting a page to `'use client'` just to
 * tell the tutor where the student is -- which would drag its data fetching
 * into the browser -- render this beside the content and pass the facts down as
 * props.
 *
 * Renders nothing. Clears what it set on unmount, so the tutor does not keep
 * describing a page the student has navigated away from.
 */

import { useEffect } from 'react';

import { useScreenContext, type ScreenContext } from './ScreenContext';

export default function ScreenContextReporter({
  tab,
  description,
  data,
}: {
  tab: string;
  description: string;
  data?: ScreenContext['data'];
}) {
  const { update, updateData } = useScreenContext();

  // Serialised, so a fresh object literal from the server does not re-fire the
  // effect on every render.
  const serialisedData = JSON.stringify(data ?? {});

  useEffect(() => {
    update({ tab, description, data: JSON.parse(serialisedData) });
    return () => {
      const cleared = Object.fromEntries(
        Object.keys(JSON.parse(serialisedData)).map((key) => [key, undefined]),
      );
      updateData(cleared);
    };
  }, [tab, description, serialisedData, update, updateData]);

  return null;
}
