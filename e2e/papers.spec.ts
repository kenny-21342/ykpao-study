import { test, expect } from '@playwright/test';
import { record, attachDiagnostics } from './helpers';

test.describe('past paper browsing and filtering', () => {
  test('the catalogue cascade narrows at every step', async ({ page }, testInfo) => {
    const r = record(page);
    await page.goto('/papers');

    await expect(page.getByRole('heading', { name: /past papers/i })).toBeVisible();

    const step = (title: string) =>
      page.locator('section').filter({ has: page.getByRole('heading', { name: new RegExp(`^${title}$`, 'i') }) });

    // 1. Curriculum
    const curriculum = step('Curriculum').locator('button').first();
    await expect(curriculum).toBeVisible({ timeout: 60_000 });
    const curriculumLabel = (await curriculum.innerText()).split('\n')[0];
    await curriculum.click();
    await expect(page).toHaveURL(/curriculum=/);

    // 2. Subject — the list must be scoped to the chosen curriculum.
    const subjects = step('Subject').locator('button');
    await expect(subjects.first()).toBeVisible({ timeout: 60_000 });
    expect(await subjects.count()).toBeGreaterThan(0);
    await subjects.first().click();
    await expect(page).toHaveURL(/subject=/);

    // 3. Year
    const years = step('Year').locator('button');
    await expect(years.first()).toBeVisible({ timeout: 60_000 });
    await years.first().click();
    await expect(page).toHaveURL(/year=/);

    // 4. Session
    const sessions = step('Exam series').locator('button');
    await expect(sessions.first()).toBeVisible({ timeout: 60_000 });
    await sessions.first().click();
    await expect(page).toHaveURL(/session=/);

    // Papers for that exact sitting.
    await expect(page.getByRole('link', { name: /paper|mark scheme|insert/i }).first()).toBeVisible({ timeout: 60_000 });

    // Deep link: the whole cascade must survive a reload.
    const deepLink = page.url();
    await page.reload();
    await expect(page).toHaveURL(deepLink);
    await expect(page.getByRole('link', { name: /paper|mark scheme|insert/i }).first()).toBeVisible({ timeout: 60_000 });

    expect(curriculumLabel.length).toBeGreaterThan(0);
    await attachDiagnostics(testInfo, r, page);
  });

  test('the catalogue API filters server-side', async ({ page }) => {
    const all = await (await page.request.get('/api/papers/catalogue')).json();
    expect(Array.isArray(all.curricula) && all.curricula.length).toBeTruthy();

    const first = all.curricula[0];
    const scoped = await (await page.request.get(`/api/papers/catalogue?curriculum=${encodeURIComponent(first.id)}`)).json();
    expect(scoped.subjects.length, 'subjects for one curriculum').toBeGreaterThan(0);
    expect(scoped.subjects.length).toBeLessThanOrEqual(first.subjectCount);

    const subject = scoped.subjects[0];
    const byYear = await (
      await page.request.get(`/api/papers/catalogue?curriculum=${encodeURIComponent(first.id)}&subject=${encodeURIComponent(subject.code)}`)
    ).json();
    expect(byYear.years.length, 'years for one subject').toBeGreaterThan(0);

    const year = byYear.years[0].year;
    const bySession = await (
      await page.request.get(
        `/api/papers/catalogue?curriculum=${encodeURIComponent(first.id)}&subject=${encodeURIComponent(subject.code)}&year=${year}`,
      )
    ).json();
    expect(bySession.sessions.length, 'sessions for one year').toBeGreaterThan(0);

    const papers = await (
      await page.request.get(
        `/api/papers/catalogue/papers?subject=${encodeURIComponent(subject.code)}&year=${year}&session=${encodeURIComponent(bySession.sessions[0].session)}`,
      )
    ).json();
    expect(papers.instances.length, 'paper instances for the sitting').toBeGreaterThan(0);
    for (const instance of papers.instances) {
      expect(instance.year).toBe(year);
      expect(instance.subjectCode).toBe(subject.code);
    }
  });
});
