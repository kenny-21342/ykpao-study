/*
 * The full-bleed artwork behind the five auth pages, in a light and a dark
 * variant that follow the theme.
 *
 * WHY THE THEME CLASS AND NOT `<picture>`: the obvious way to serve two
 * artworks is `<source media="(prefers-color-scheme: dark)">`, and it is wrong
 * here. This app does not take its theme from the OS directly -- `theme-init`
 * in app/layout.tsx reads localStorage first and only falls back to
 * `prefers-color-scheme`, then writes `.dark` on <html>. A student who had
 * toggled the app to dark on a light laptop would get the light artwork behind
 * a dark form. Keying off the same `.dark` the rest of the app uses is right in
 * that case, and still follows the system for everyone who has never touched
 * the toggle, because that is where the class comes from in the first place.
 *
 * WHY ONE ELEMENT AND A CSS VARIABLE: the first version of this was two divs
 * swapped with `dark:hidden` / `hidden dark:block`, on the theory that an
 * element with `display: none` generates no box and so never fetches its
 * background. Measured against the deployment, Chrome requested BOTH files
 * anyway -- 348 KB to paint 190. A custom property has no such ambiguity: only
 * the value that actually resolves on the element is ever loaded, so the
 * variant off-screen costs nothing. `--auth-hero` is defined once per theme in
 * app/globals.css alongside the other tokens.
 *
 * The artwork is a 3840x2160 render re-encoded to 2400w WebP (153/190 KB).
 * Sources live in design/auth-hero/, which is gitignored.
 */
export default function AuthBackground() {
  return (
    <div
      aria-hidden
      // `fixed` so the artwork stays put while a tall form -- signup, at a
      // phone width -- scrolls over it.
      className="fixed inset-0 bg-cover bg-center"
      style={{ backgroundImage: 'var(--auth-hero)' }}
    />
  );
}
