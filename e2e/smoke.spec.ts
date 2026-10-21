import { expect, test, type Page } from '@playwright/test';

/** Runs against the keyless demo (mock provider), so it's deterministic in CI. */

async function signUp(page: Page) {
  const email = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
  await page.goto('/login');
  await page.getByRole('button', { name: 'New here? Create an account' }).click();
  await page.getByPlaceholder('Your name').fill('Robin Tester');
  await page.getByPlaceholder('Email').fill(email);
  await page.getByPlaceholder(/Password/).fill('correct horse battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: /Good (morning|afternoon|evening), Robin/ })).toBeVisible();
}

test('sign up, quick-capture a task, and complete it', async ({ page }) => {
  await signUp(page);

  await page.getByLabel('Quick capture').fill('Renew passport tomorrow, high prio #travel');
  await page.getByLabel('Quick capture').press('Enter');
  const preview = page.getByRole('dialog', { name: 'Capture preview' });
  await expect(preview.getByLabel('Title')).toHaveValue('Renew passport');
  await preview.getByRole('button', { name: /Save task/ }).click();

  await page.getByRole('link', { name: 'All tasks' }).click();
  const row = page.getByRole('listitem').filter({ hasText: 'Renew passport' });
  await expect(row).toContainText('Tomorrow');
  await expect(row).toContainText('#travel');
  await row.getByRole('button', { name: 'Complete task' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: 'Renew passport' })).toHaveCount(0);
});

test('assistant proposes a change and only applies it after approval', async ({ page }) => {
  await signUp(page);
  await page.getByRole('link', { name: 'Assistant' }).click();

  await page.getByLabel('Message').fill('remind me to call mom tomorrow at 6pm');
  await page.getByRole('button', { name: 'Send' }).click();

  const card = page.getByRole('dialog', { name: 'Confirm actions' });
  await expect(card).toContainText('Create task "Call mom"');
  await expect(card).toContainText('6:00');

  // Nothing exists until approved.
  await page.goto('/tasks');
  await expect(page.getByText('No tasks here.')).toBeVisible();

  await page.getByRole('link', { name: 'Assistant' }).click();
  await page.getByRole('button', { name: /remind me to call mom/ }).click();
  await page
    .getByRole('dialog', { name: 'Confirm actions' })
    .getByRole('button', { name: /Approve/ })
    .click();
  await expect(page.getByText('Done: "Call mom"')).toBeVisible();

  await page.getByRole('link', { name: 'All tasks' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: 'Call mom' })).toContainText('via chat');
});

test('notes are searchable by meaning once indexed by the worker', async ({ page }) => {
  await signUp(page);
  await page.getByRole('link', { name: 'Notes' }).click();
  await page.getByRole('button', { name: 'New note' }).click();
  await page.getByLabel('Note title').fill('Car insurance');
  await page.getByLabel('Note body').fill('The renewal is due in March. Compare quotes from three providers first.');
  await expect(page.getByText('Indexed')).toBeVisible({ timeout: 15_000 });

  await page.getByPlaceholder(/Search by meaning/).fill('insurance renewal');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByRole('button', { name: /Car insurance/ }).first()).toBeVisible();
});
