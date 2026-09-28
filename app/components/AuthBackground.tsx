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
 * ONLY THE RESOLVED VARIANT IS FETCHED. Both URLs sit in the stylesheet, so
 * this is worth stating rather than assuming: a controlled test (two themes,
 * distinct files, a server access log) confirmed Chrome requests exactly one of
 * them, for a `url()` in a custom property as much as for a rule that matches
 * no element. The off-screen variant costs nothing. The artwork is a 3840x2160
 * render re-encoded to 2400w WebP -- 153 KB light, 190 KB dark -- so getting
 * this wrong would have doubled the weight of the app's first screen.
 *
 * `--auth-hero` is defined once per theme in app/globals.css beside the other
 * tokens; one element reads it. Sources live in design/auth-hero/ (gitignored).
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
