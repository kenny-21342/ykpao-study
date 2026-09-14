/**
 * Join class names, dropping anything falsy.
 *
 * Deliberately nine lines rather than `clsx` + `tailwind-merge` + `cva`. The
 * whole app has seven variant axes, which is a `Record` lookup — and
 * HomeShell's `statToneStyles` already established that pattern here, so
 * hand-rolling follows the codebase rather than importing a convention into
 * it. `cva` without `tailwind-merge` also buys class-order bugs, and
 * `tailwind-merge` needs config awareness for a v4 CSS-first setup with custom
 * scales. That is real integration cost for no benefit at this size.
 *
 * Consequence to know: there is no conflict resolution. A caller's `className`
 * wins only because every primitive appends it last.
 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
