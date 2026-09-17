import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

test('GitHub-native demo opens on the exception Inbox and exposes read-only Issues/Project facts', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Enter isolated GitHub-shaped FAKE demo' }).click();
  await expect(page.getByRole('heading', { name: 'GitHub needs attention' })).toBeVisible();
  await expect(page.getByText('untracked change', { exact: true })).toBeVisible();
  await expect(page.getByText('issue missing project', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Context' }).click();
  await expect(page.getByRole('heading', { name: 'GitHub project facts' })).toBeVisible();
  await expect(page.getByText('Observed Issues (2)', { exact: true })).toBeVisible();
  await expect(page.getByText(/Project status: Todo/)).toBeVisible();
});

test('legacy local task mutation is rejected with GitHub guidance', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Enter isolated GitHub-shaped FAKE demo' }).click();
  const result = await page.evaluate(async () => {
    const me = await fetch('/api/me').then(response => response.json());
    const response = await fetch('/api/tasks', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Origin: location.origin, 'X-CSRF-Token': me.csrf_token }, body: JSON.stringify({ title: 'local task', type: 'bug' }) });
    return { status: response.status, body: await response.json() };
  });
  expect(result.status).toBe(410);
  expect(result.body.error).toContain('GitHub Issues');
});
