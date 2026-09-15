'use client';

import { useCallback, useState, useSyncExternalStore } from 'react';
import { Download, Filter, Plus, Trash2 } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardRow,
  CardTitle,
  Checkbox,
  Field,
  Input,
  PageHeader,
  SegmentedControl,
  Select,
  StatRow,
  StatTile,
  Textarea,
} from '@/app/components/ui';

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
  ['accent-active', 'bg-accent-active', 'text-accent-fg'],
  ['accent-subtle', 'bg-accent-subtle', 'text-accent-text'],
] as const;

const SEMANTIC = [
  ['danger', 'bg-danger', 'text-inverse'],
  ['danger-subtle', 'bg-danger-subtle', 'text-danger'],
  ['warning', 'bg-warning', 'text-inverse'],
  ['warning-subtle', 'bg-warning-subtle', 'text-warning'],
] as const;

/* Added after Phase 1, so the styleguide did not know about them. */
const INVERSE = [
  ['surface-inverse', 'bg-surface-inverse', 'text-inverse'],
  ['surface-inverse-hover', 'bg-surface-inverse-hover', 'text-inverse'],
] as const;

/*
 * The one place hue still carries information: five accuracy bands. Both
 * themes are on screen here together, which is the point -- the labels take
 * --text-inverse, which FLIPS with the theme, so the light steps have to be
 * darker than the dark ones. Three of five were below 4.5:1 when first
 * written because I had that backwards.
 */
const BANDS = [
  ['band-1', 'bg-band-1', 'Critical'],
  ['band-2', 'bg-band-2', 'Weak'],
  ['band-3', 'bg-band-3', 'OK'],
  ['band-4', 'bg-band-4', 'Strong'],
  ['band-5', 'bg-band-5', 'Mastered'],
] as const;

const TYPE = [
  ['text-xl', 'text-xl', '28px — page titles'],
  ['text-lg', 'text-lg', '20px — section headings'],
  ['text-base', 'text-base', '16px — body'],
  ['text-sm', 'text-sm', '14px — dense UI'],
  ['text-xs', 'text-xs', '13px — metadata'],
] as const;

/*
 * This table documents class names as data, so the radius sweep rewrote it
 * along with the code it describes -- leaving two `rounded-md` rows, one of
 * them labelled 10px, and two rows for the xl/2xl aliases that no longer
 * exist. Three scales, one rule, and nothing aliased.
 */
const RADII = [
  ['rounded-sm', '4px — badges, chips'],
  ['rounded-md', '6px — a control you operate'],
  ['rounded-lg', '10px — a surface you put things on'],
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
  const [segment, setSegment] = useState<'browse' | 'practice' | 'starred'>('browse');
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
          <div className="rounded-md border border-line overflow-hidden">
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
              <div key={name} className={`rounded-md border-2 ${cls} bg-surface px-4 py-3 min-w-[13rem]`}>
                <code className="font-mono text-xs text-primary block">{cls}</code>
                <span className="text-xs text-muted">{use}</span>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Text" note="Three tones. Muted is for metadata only — it is deliberately below body contrast.">
          <div className="rounded-md border border-line bg-surface p-4 space-y-2">
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
              <div key={name} className={`${bg} ${fg} rounded-md px-5 py-4 min-w-[13rem] border border-line`}>
                <code className="font-mono text-xs block">{bg}</code>
                <span className="text-sm">Primary action</span>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Semantic" note="Warning and danger carry meaning. They are never used for decoration.">
          <div className="flex flex-wrap gap-3">
            {SEMANTIC.map(([name, bg, fg]) => (
              <div key={name} className={`${bg} ${fg} rounded-md px-5 py-4 min-w-[12rem] border border-line`}>
                <code className="font-mono text-xs block">{bg}</code>
                <span className="text-sm">Sample</span>
              </div>
            ))}
          </div>
        </Section>

        <Section
          title="Inverse surface"
          note="The high-contrast confirm button and selected pill. The one surface that flips with the theme rather than shifting."
        >
          <div className="flex flex-wrap gap-3">
            {INVERSE.map(([name, bg, fg]) => (
              <div key={name} className={`${bg} ${fg} rounded-md px-5 py-4 min-w-[14rem] border border-line`}>
                <code className="font-mono text-xs block">{bg}</code>
                <span className="text-sm">Confirm</span>
              </div>
            ))}
          </div>
        </Section>

        <Section
          title="Accuracy bands"
          note="The only place hue still carries information. Labels take --text-inverse, which flips with the theme — so the light steps are darker than the dark ones, and every step is measured at 4.5:1 or better against the label it actually gets."
        >
          <div className="flex flex-wrap gap-2">
            {BANDS.map(([name, bg, label]) => (
              <div key={name} className={`${bg} text-inverse rounded-md px-4 py-3 min-w-[9rem]`}>
                <code className="font-mono text-xs block opacity-80">{bg}</code>
                <span className="text-sm font-semibold">{label}</span>
              </div>
            ))}
          </div>
        </Section>

        <Section
          title="Type scale"
          note="13 / 14 / 16 / 20 / 28. Previously 89% of all text sat at 12–14px and hierarchy was carried by weight alone."
        >
          <div className="rounded-md border border-line bg-surface p-5 space-y-3">
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
          <table className="rounded-md border border-line bg-surface text-sm w-full max-w-md">
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

        <Section title="Button" note="Five variants, two sizes. No gradient, no shadow — a filled accent says primary on its own.">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary">Primary</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="danger">Danger</Button>
              <Button variant="link">Link</Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" icon={Plus}>With icon</Button>
              <Button variant="secondary" icon={Download} iconPosition="end">Icon at end</Button>
              <Button variant="secondary" loading>Loading</Button>
              <Button variant="secondary" disabled>Disabled</Button>
              <Button variant="ghost" size="sm" icon={Trash2} aria-label="Delete this item" />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="primary">Small</Button>
              <Button size="sm" variant="secondary">Small</Button>
            </div>
            <p className="text-xs text-muted">Tab to any button to check the focus ring.</p>
          </div>
        </Section>

        <Section title="Badge">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>Neutral</Badge>
            <Badge tone="accent">Verified</Badge>
            <Badge tone="warning">Preview</Badge>
            <Badge tone="danger">Overdue</Badge>
          </div>
        </Section>

        <Section
          title="Card"
          note="Padded card, and a card of hairline-divided rows. The second replaces lists where every item carried its own border, background and radius."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Rates of reaction</CardTitle>
                  <CardDescription>Chemistry · 0620 · 4 marks</CardDescription>
                </div>
                <Badge tone="warning">Needs review</Badge>
              </CardHeader>
              <CardFooter>
                <Button variant="primary" size="sm">Practise</Button>
                <Button variant="ghost" size="sm">Mark scheme</Button>
              </CardFooter>
            </Card>

            <Card padding="none">
              <CardRow interactive>
                <span className="text-sm text-primary flex-1">Acids, bases and salts</span>
                <span className="text-sm text-muted tabular-nums">1 / 4</span>
              </CardRow>
              <CardRow interactive>
                <span className="text-sm text-primary flex-1">Energy changes</span>
                <span className="text-sm text-muted tabular-nums">108 / 120</span>
              </CardRow>
              <CardRow interactive>
                <span className="text-sm text-primary flex-1">Electrolysis</span>
                <span className="text-sm text-muted tabular-nums">12 / 30</span>
              </CardRow>
            </Card>
          </div>
        </Section>

        <Section title="Stat row" note="Borderless. Four equivalent numbers do not need four cards or four accent colours.">
          <Card>
            <StatRow>
              <StatTile label="Questions answered" value="93" delta={{ value: '+244% this week', direction: 'up' }} />
              <StatTile label="Accuracy" value="18%" hint="Keep practising" />
              <StatTile label="Study streak" value="0 days" delta={{ value: 'broken', direction: 'down' }} />
              <StatTile label="Hours studied" value="0h" />
            </StatRow>
          </Card>
        </Section>

        <Section title="Segmented control" note="Arrow keys move between options; only the selected one is in the tab order.">
          <SegmentedControl
            ariaLabel="Question view"
            value={segment}
            onChange={setSegment}
            items={[
              { value: 'browse', label: 'Browse' },
              { value: 'practice', label: 'Practice' },
              { value: 'starred', label: 'Starred', icon: Filter },
            ]}
          />
          <p className="mt-2 text-xs text-muted">Selected: <code className="font-mono">{segment}</code></p>
        </Section>

        <Section title="Fields" note="Field owns the label, the ids, aria-describedby and aria-invalid — the parts that were forgotten more often than not.">
          <Card className="grid gap-4 sm:grid-cols-2">
            <Field label="Display name" hint="Shown on your discussion posts.">
              {({ id, describedBy }) => (
                <Input id={id} aria-describedby={describedBy} placeholder="Kenny Lin" defaultValue="" />
              )}
            </Field>
            <Field label="Subject" required>
              {({ id, describedBy }) => (
                <Select id={id} aria-describedby={describedBy} defaultValue="">
                  <option value="">Choose a subject</option>
                  <option value="0620">Chemistry (0620)</option>
                  <option value="9702">Physics (9702)</option>
                </Select>
              )}
            </Field>
            <Field label="Exam date" error="That date is in the past.">
              {({ id, describedBy, invalid }) => (
                <Input id={id} aria-describedby={describedBy} invalid={invalid} defaultValue="2020-05-01" />
              )}
            </Field>
            <Field label="Notes" hint="Optional.">
              {({ id, describedBy }) => (
                <Textarea id={id} aria-describedby={describedBy} placeholder="Anything to remember" />
              )}
            </Field>
            <div className="sm:col-span-2">
              <Checkbox label="Email me when a mark scheme is added" defaultChecked />
            </div>
          </Card>
        </Section>

        <Section title="Page header" note="Not a card. A page title should be the largest thing on the screen.">
          <Card>
            <PageHeader
              eyebrow="Chemistry · 0620"
              title="Paper 4, May/June 2023"
              description="Forty marks, cut into eleven questions. Mark scheme attached."
              actions={<><Button variant="secondary" size="sm" icon={Download}>Download</Button><Button variant="primary" size="sm">Practise</Button></>}
              back={{ href: '/admin/styleguide', label: 'All papers' }}
            />
          </Card>
        </Section>

        <Section title="Elevation" note="The single surviving shadow. Overlays only — dialogs, menus, toasts.">
          <div className="rounded-md bg-surface border border-line p-5 shadow-overlay max-w-sm">
            <p className="text-sm font-medium text-primary">shadow-overlay</p>
            <p className="text-xs text-muted mt-1">Everything that does not float uses a border instead.</p>
          </div>
        </Section>
      </div>
    </main>
  );
}
