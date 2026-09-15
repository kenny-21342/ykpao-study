import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const AUTH = path.join(ROOT, 'app/auth');

async function authPages(): Promise<Array<{ name: string; src: string }>> {
  const dirs = await readdir(AUTH, { withFileTypes: true });
  return Promise.all(
    dirs.filter((d) => d.isDirectory()).map(async (d) => ({
      name: d.name,
      src: await readFile(path.join(AUTH, d.name, 'page.tsx'), 'utf8'),
    })),
  );
}

test('every auth input is labelled through the Field primitive', async () => {
  // Nine of the ten inputs across these five pages had a <label> with no
  // htmlFor and an input with no id, so clicking the label did nothing and a
  // screen reader announced an unnamed edit box. Field owns that wiring, which
  // is the whole reason it takes a render prop.
  for (const { name, src } of await authPages()) {
    const inputs = (src.match(/<input\b/g) ?? []).length;
    if (inputs === 0) continue;

    const fields = (src.match(/<Field\b/g) ?? []).length;
    assert.equal(fields, inputs,
      `${name}: ${inputs} inputs but ${fields} Fields — one is hand-rolled`);

    assert.doesNotMatch(src, /<label className=/,
      `${name} still hand-writes a label; Field renders it with the htmlFor attached`);
  }
});

test('every auth input tells the password manager what it is', async () => {
  // Kenny cannot have passwords typed into these forms by hand, so the
  // password-manager path is the real one. It keys on autocomplete.
  for (const { name, src } of await authPages()) {
    const inputs = (src.match(/<input\b/g) ?? []).length;
    const autos = (src.match(/autoComplete=/g) ?? []).length;
    assert.equal(autos, inputs, `${name}: ${inputs} inputs but ${autos} autoComplete hints`);
  }

  const byName = Object.fromEntries((await authPages()).map((p) => [p.name, p.src]));
  // Sign-in must offer the saved password; the three that set one must not,
  // or a manager overwrites the existing entry instead of creating one.
  assert.match(byName.login, /autoComplete="current-password"/);
  for (const page of ['signup', 'reset-password']) {
    assert.match(byName[page], /autoComplete="new-password"/, `${page} asks for the wrong password kind`);
    assert.doesNotMatch(byName[page], /autoComplete="current-password"/);
  }
});

test('the accent carries its own foreground token', async () => {
  // `bg-accent text-white` happens to be right only because --accent-fg is
  // white today. Naming the token means changing the accent cannot silently
  // leave white text on a pale button.
  for (const { name, src } of await authPages()) {
    assert.doesNotMatch(src, /(?<![\w:-])text-white(?![\w/-])/,
      `${name} hardcodes white instead of the accent's foreground token`);
  }
});
