'use client';

import { useEffect, useState } from 'react';

/**
 * Whether this tab is worth spending server work on.
 *
 * A tab is "active" when it is visible *and* someone has interacted with it
 * recently. It goes dormant when hidden, or after `idleAfterMs` of no
 * interaction, and wakes on the next interaction or on becoming visible.
 *
 * This exists because of a real outage. `NotificationBell` held an SSE
 * connection whose server side ran `notification.count()` every 15 seconds,
 * plus a 30-second client poll of `/api/notifications` — about six
 * database-touching requests a minute, for the life of the tab, whether or
 * not anyone was looking at it. Neon suspends a compute after five minutes of
 * inactivity, so a single forgotten signed-in tab meant the database never
 * once got to idle: it stayed awake for ten days straight, burned the whole
 * monthly compute allowance on 19 Sep 2026 with eleven days left in the
 * month, and took production down until the quota reset.
 *
 * The cost of an idle tab therefore is not "a bit of extra load". It is the
 * difference between a database that sleeps and one that never does. Anything
 * polling on a timer behind a signed-in session should gate on this.
 */
export function useTabActive(idleAfterMs = 10 * 60_000): boolean {
  // Read visibility at mount rather than assuming true and correcting inside
  // the effect: a tab restored into the background on session restore would
  // otherwise connect once before being told to stop. On the server there is
  // no `document`, and the value gates effects rather than markup, so there
  // is nothing for hydration to disagree about.
  const [active, setActive] = useState(
    () =>
      typeof document === 'undefined' || document.visibilityState !== 'hidden',
  );

  useEffect(() => {
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const hidden = () =>
      typeof document !== 'undefined' && document.visibilityState === 'hidden';

    const goIdle = () => setActive(false);

    const armIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(goIdle, idleAfterMs);
    };

    const markActive = () => {
      if (hidden()) return;
      setActive(true);
      armIdleTimer();
    };

    const onVisibility = () => {
      if (hidden()) {
        if (idleTimer) clearTimeout(idleTimer);
        setActive(false);
      } else {
        markActive();
      }
    };

    // `pointermove` is deliberately absent: it fires continuously and would
    // keep a tab "active" under a cat on the trackpad. Deliberate acts only.
    const events = ['pointerdown', 'keydown', 'scroll', 'focus'] as const;
    events.forEach((name) =>
      window.addEventListener(name, markActive, { passive: true }),
    );
    document.addEventListener('visibilitychange', onVisibility);

    if (!hidden()) armIdleTimer();

    return () => {
      if (idleTimer) clearTimeout(idleTimer);
      events.forEach((name) => window.removeEventListener(name, markActive));
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [idleAfterMs]);

  return active;
}
