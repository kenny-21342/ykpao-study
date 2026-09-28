/*
 * The full-bleed background behind the five auth pages, in two variants that
 * follow the theme.
 *
 * WHY TWO ELEMENTS AND NOT `<picture>`: the obvious way to serve a light and a
 * dark artwork is a `<source media="(prefers-color-scheme: dark)">`, and it is
 * wrong here. This app does not take its theme from the OS directly -- the
 * `theme-init` script in app/layout.tsx reads localStorage first and only falls
 * back to `prefers-color-scheme`, then writes `.dark` on <html>. A student who
 * has toggled the app to dark on a light laptop would get the light artwork
 * behind a dark form. Keying off the same `.dark` class the rest of the app
 * uses is correct in both cases, and still "follows the system" for everyone
 * who has never touched the toggle, because that is where the class comes from.
 *
 * WHY CSS BACKGROUNDS AND NOT `next/image`: both variants are in the DOM, and
 * two <img> elements would both be fetched even with one hidden -- ~340 KB to
 * paint 190 KB. A background-image on a `display: none` element generates no
 * box, so no engine fetches it; only the variant actually shown is downloaded.
 * The cost is next/image's srcset, which buys little for a single decorative
 * cover image that is already sized for the largest realistic viewport.
 *
 * The artwork is a 3840x2160 render re-encoded to 2400w WebP (153/190 KB).
 * Sources live in design/auth-hero/, which is gitignored.
 */
export default function AuthBackground() {
  // Both are `fixed inset-0` so the artwork stays put while a tall form
  // (signup, at a phone width) scrolls over it.
  const base = 'fixed inset-0 bg-cover bg-center';

  return (
    <>
      <div
        aria-hidden
        className={`${base} bg-[url('/auth-hero-light.webp')] dark:hidden`}
      />
      <div
        aria-hidden
        className={`${base} hidden bg-[url('/auth-hero-dark.webp')] dark:block`}
      />
    </>
  );
}
