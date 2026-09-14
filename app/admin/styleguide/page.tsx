'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * The QA surface for the restyle.
 *
 * Every token and primitive on one screen, in both themes. This exists because
 * the alternative is checking a colour by hunting for a screen that happens to
 * use it, and because the one failure mode that is invisible in code review --
 * a themed colour declared in a plain `@theme` block instead of `@theme
 * inline`, which bakes a static value and silently stops switching -- shows up
 * here in one click.
 *
 * Admin-gated for free: app/admin/layout.tsx runs requireAdmin() on every
 * request for the whole segment, so this ships to production safely.
 */

const SURFACES = [
  ['canvas', 'bg-canvas', 'page ground'],
  ['surface', 'bg-surface', 'cards, panels'],
  ['surface-raised', 'bg-surface-raised', 'toolbars, table headers, inset rows'],
  ['surface-hover', 'bg-surface-hover', 'hover'],
  ['surface-active', 'bg-surface-active', 'active nav item'],
] as const;

const BORDERS = [
  ['subtle', 'border-subtle', 'dividers inside a card'],
  ['line', 'border-line', 'card outline — the default'],
  ['strong', 'border-strong', 'inputs'],
] as const;

const TEXT = [
  ['primary', 'text-primary', 'body and headings'],
  ['secondary', 'text-secondary', 'supporting copy'],
  ['muted', 'text-muted', 'metadata only — never essential text'],
] as const;

const ACCENT = [
  ['accent', 'bg-accent', 'text-accent-fg'],
  ['accent-hover', 'bg-accent-hover', 'text-accent-fg'],
  ['accent-subtle', 'bg-accent-subtle', 'text-accent-text'],
] as const;

const SEMANTIC = [
  ['danger', 'bg-danger', 'text-inverse'],
  ['danger-subtle', 'bg-danger-subtle', 'text-danger'],
  ['warning', 'bg-warning', 'text-inverse'],
  ['warning-subtle', 'bg-warning-subtle', 'text-warning'],
] as const;

const TYPE = [
  ['text-xl', 'text-xl', '28px — page titles'],
  ['text-lg', 'text-lg', '20px — section headings'],
  ['text-base', 'text-base', '16px — body'],
  ['text-sm', 'text-sm', '14px — dense UI'],
  ['text-xs', 'text-xs', '13px — metadata'],
] as const;

const RADII = [
  ['rounded-sm', '4px — badges, chips'],
  ['rounded-md', '6px — buttons, inputs, rows'],
  ['rounded-lg', '10px — cards, panels, modals'],
  ['rounded-xl', 'aliased to 10px'],
  ['rounded-2xl', 'aliased to 10px'],
] as const;

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="mb-10">
      <h2 className="text-lg font-semibold text-primary">{title}</h2>
      {note && <p className="mt-1 mb-4 text-sm text-secondary max-w-2xl">{note}</p>}
      <div className={note ? '' : 'mt-4'}>{children}</div>
    </section>
  );
}

/**
 * The theme lives as a class on <html>, set before hydration by the script in
 * app/layout.tsx. Reading it through useSyncExternalStore rather than an
 * effect keeps the server snapshot explicit and avoids setting state during an
 * effect — the same pattern AppSidebar uses for its collapsed state.
 */
function subscribeToTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}

export default function StyleGuide() {
  const isDark = useSyncExternalStore(
    subscribeToTheme,
    () => document.documentElement.classList.contains('dark'),
    () => false,
  );

  const toggle = useCallback(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', !root.classList.contains('dark'));
  }, []);

  return (
    <main className="min-h-screen bg-canvas px-6 py-10">
      <div className="mx-auto max-w-4xl">
        <header className="mb-10 flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted">Internal</p>
            <h1 className="text-xl font-semibold text-primary">Style guide</h1>
            <p className="mt-1 text-sm text-secondary max-w-xl">
              Every token in both themes. If a swatch below stops changing when you
              toggle the theme, its colour was declared outside <code className="font-mono text-xs">@theme inline</code>.
            </p>
          </div>
          <button
            type="button"
            onClick={toggle}
            aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
            className="shrink-0 rounded-md border border-line bg-surface px-3 py-2 text-sm font-medium text-primary hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
          >
            {isDark ? 'Light' : 'Dark'} theme
          </button>
        </header>

        <Section
          title="Surfaces"
          note="Separation comes from these background steps and from borders. There are no shadows outside overlays."
        >
          <div className="rounded-lg border border-line overflow-hidden">
            {SURFACES.map(([name, cls, use]) => (
              <div key={name} className={`${cls} flex items-center gap-4 px-4 py-3 border-b border-subtle last:border-0`}>
                <code className="font-mono text-xs text-primary w-40 shrink-0">{cls}</code>
                <span className="text-sm text-secondary">{use}</span>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Borders">
          <div className="flex flex-wrap gap-3">
            {BORDERS.map(([name, cls, use]) => (
              <div key={name} className={`rounded-lg border-2 ${cls} bg-surface px-4 py-3 min-w-[13rem]`}>
                <code className="font-mono text-xs text-primary block">{cls}</code>
                <span className="text-xs text-muted">{use}</span>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Text" note="Three tones. Muted is for metadata only — it is deliberately below body contrast.">
          <div className="rounded-lg border border-line bg-surface p-4 space-y-2">
            {TEXT.map(([name, cls, use]) => (
              <p key={name} className={`${cls} text-base`}>
                <code className="font-mono text-xs">{cls}</code>
                <span className="mx-2">·</span>
                The quick brown fox jumps over the lazy dog — {use}
              </p>
            ))}
          </div>
        </Section>

        <Section title="Accent" note="One hue. It marks the primary action and nothing else.">
          <div className="flex flex-wrap gap-3">
            {ACCENT.map(([name, bg, fg]) => (
              <div key={name} className={`${bg} ${fg} rounded-lg px-5 py-4 min-w-[13rem] border border-line`}>
                <code className="font-mono text-xs block">{bg}</code>
                <span className="text-sm">Primary action</span>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Semantic" note="Warning and danger carry meaning. They are never used for decoration.">
          <div className="flex flex-wrap gap-3">
            {SEMANTIC.map(([name, bg, fg]) => (
              <div key={name} className={`${bg} ${fg} rounded-lg px-5 py-4 min-w-[12rem] border border-line`}>
                <code className="font-mono text-xs block">{bg}</code>
                <span className="text-sm">Sample</span>
              </div>
            ))}
          </div>
        </Section>

        <Section
          title="Type scale"
          note="13 / 14 / 16 / 20 / 28. Previously 89% of all text sat at 12–14px and hierarchy was carried by weight alone."
        >
          <div className="rounded-lg border border-line bg-surface p-5 space-y-3">
            {TYPE.map(([name, cls, use]) => (
              <div key={name} className="flex items-baseline gap-4">
                <code className="font-mono text-xs text-muted w-24 shrink-0">{cls}</code>
                <span className={`${cls} font-semibold text-primary`}>Marks and mark schemes</span>
                <span className="text-xs text-muted">{use}</span>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Radius" note="Three values. xl and 2xl are aliased onto lg so existing call sites are already correct.">
          <div className="flex flex-wrap gap-3">
            {RADII.map(([cls, use]) => (
              <div key={cls} className={`${cls} border border-line bg-surface-raised px-4 py-6 min-w-[11rem]`}>
                <code className="font-mono text-xs text-primary block">{cls}</code>
                <span className="text-xs text-muted">{use}</span>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Figures" note="Tabular by default inside tables, so columns of marks line up.">
          <table className="rounded-lg border border-line bg-surface text-sm w-full max-w-md">
            <thead>
              <tr className="border-b border-subtle bg-surface-raised">
                <th className="px-4 py-2 text-left font-medium text-secondary">Topic</th>
                <th className="px-4 py-2 text-right font-medium text-secondary">Marks</th>
              </tr>
            </thead>
            <tbody className="text-primary">
              {[['Rates of reaction', '0 / 2'], ['Acids, bases, salts', '11 / 14'], ['Energy changes', '108 / 120']].map(([t, m]) => (
                <tr key={t} className="border-b border-subtle last:border-0">
                  <td className="px-4 py-2">{t}</td>
                  <td className="px-4 py-2 text-right">{m}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        <Section title="Elevation" note="The single surviving shadow. Overlays only — dialogs, menus, toasts.">
          <div className="rounded-lg bg-surface border border-line p-5 shadow-overlay max-w-sm">
            <p className="text-sm font-medium text-primary">shadow-overlay</p>
            <p className="text-xs text-muted mt-1">Everything that does not float uses a border instead.</p>
          </div>
        </Section>
      </div>
    </main>
  );
}
