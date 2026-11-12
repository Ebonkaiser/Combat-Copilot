import AxeBuilder from '@axe-core/playwright';
import { expect, Page, Route, test } from '@playwright/test';
import { addCombatant, expectNoContrastViolations, openApp } from './helpers';

const CORS = { 'access-control-allow-origin': '*' };

// Replaces the live Gemini-backed damage stream with a canned SSE response so
// the test is deterministic, free, and can still show conditions, a 0-HP
// target and streamed narration in the DOM.
async function mockDamageStream(page: Page): Promise<void> {
  await page.route('**/encounters/*/damage/stream', async (route: Route) => {
    const encounterUrl = route.request().url().replace(/\/damage\/stream$/, '');
    const { target_id } = route.request().postDataJSON() as { target_id: string };
    const encounter = await (await page.request.get(encounterUrl)).json();
    const combatants = encounter.combatants.map((c: { id: string; conditions: string[] }) =>
      c.id === target_id ? { ...c, current_hp: 0, conditions: [...c.conditions, 'Incapacitated', 'Stunned'] } : c,
    );
    const sse = [
      `event: state_update\ndata: ${JSON.stringify({ combatants })}\n\n`,
      `event: narrative_chunk\ndata: ${JSON.stringify({ token: 'The blade bites deep. ' })}\n\n`,
      `event: narrative_chunk\ndata: ${JSON.stringify({ token: 'Its owner crumples to the stones.' })}\n\n`,
      `event: end\ndata: [DONE]\n\n`,
    ].join('');
    await route.fulfill({ status: 200, headers: CORS, contentType: 'text/event-stream', body: sse });
  });
}

test.describe('sepia theme', () => {
  test('page uses the sepia tokens and a visible focus outline', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(244, 236, 216)');
    await expect(page.locator('body')).toHaveCSS('color', 'rgb(59, 47, 34)');

    await page.keyboard.press('Tab');
    const focused = page.locator(':focus-visible');
    await expect(focused).toHaveCSS('outline-style', 'solid');
    await expect(focused).toHaveCSS('outline-width', '2px');
    await expect(focused).toHaveCSS('outline-color', 'rgb(122, 62, 22)');
  });

  test('negative control: axe does flag a deliberate contrast regression', async ({ page }) => {
    await openApp(page);
    await page.addStyleTag({ content: '.page-subtitle { color: #c8bfa8 !important; }' });
    const results = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
    expect(results.violations.length).toBeGreaterThan(0);
  });

  test('every themed HUD state passes the axe color-contrast rule', async ({ page }) => {
    await mockDamageStream(page);
    await openApp(page);
    await expectNoContrastViolations(page, '01 empty HUD');

    await page.getByTestId('add-combatant-btn').click();
    await expectNoContrastViolations(page, '02 add combatant modal');
    await page.getByRole('button', { name: 'Cancel' }).click();

    await addCombatant(page, { name: 'Goblin Scout', type: 'enemy', initiative: 14, hp: 12, ac: 13 });
    await addCombatant(page, { name: 'Hero', type: 'player', initiative: 9, hp: 30, ac: 16 });
    await expectNoContrastViolations(page, '03 two combatants, combat not started');

    await page.getByTestId('start-combat-btn').click();
    await page.locator('.combatant', { hasText: 'Hero' }).click();
    await page.locator('.combatant', { hasText: 'Goblin Scout' }).hover();
    await expectNoContrastViolations(page, '04 combat started, target selected, active turn, hover');

    await page.getByTestId('open-damage-modal-btn').click();
    const modal = page.locator('.modal');
    await modal.getByRole('button', { name: 'Add Condition' }).click();
    await modal.getByPlaceholder('Stunned, Prone, Poisoned...').fill('Stunned');
    await expectNoContrastViolations(page, '05 manage modal, add-condition active');
    await modal.getByRole('button', { name: 'Remove Condition' }).click();
    await expectNoContrastViolations(page, '06 manage modal, remove-condition active');
    await modal.getByRole('button', { name: 'Add Condition' }).click();
    await modal.locator('.row input[type="number"]').first().fill('99');
    await modal.getByRole('button', { name: 'Save Changes' }).click();

    await expect(page.locator('.chip', { hasText: 'Stunned' })).toBeVisible();
    await expect(page.locator('.stream')).toContainText('Its owner crumples to the stones.');
    await expectNoContrastViolations(page, '07 conditions, 0 HP target, narration stream');

    await page.getByRole('button', { name: 'New Encounter' }).click();
    await expectNoContrastViolations(page, '08 new encounter confirm modal');
  });

  test('connection-error banner passes color-contrast', async ({ page }) => {
    await page.route('**/health', (route) =>
      route.fulfill({
        status: 503,
        headers: CORS,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'error', detail: 'Backend failed to start. Check server logs.' }),
      }),
    );
    await page.goto('/');
    await expect(page.locator('.banner-error')).toContainText('Backend failed to start');
    await expectNoContrastViolations(page, '09 connection error banner');
  });

  test('backend-starting state passes color-contrast', async ({ page }) => {
    await page.route('**/health', (route) =>
      route.fulfill({
        status: 503,
        headers: CORS,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'starting' }),
      }),
    );
    await page.goto('/');
    await expect(page.locator('.status-starting')).toBeVisible();
    await expectNoContrastViolations(page, '10 backend starting');
  });
});
