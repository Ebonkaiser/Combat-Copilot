import AxeBuilder from '@axe-core/playwright';
import { expect, Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const OWNER_EMAIL = 'owner@example.test';

// Set E2E_SHOTS_DIR to also save a full-page screenshot of every state checked.
export const shotsDir = process.env['E2E_SHOTS_DIR'];
if (shotsDir) {
  mkdirSync(shotsDir, { recursive: true });
}

/** Fails if axe finds any WCAG color-contrast violation in the current page state. */
export async function expectNoContrastViolations(page: Page, state: string): Promise<void> {
  if (shotsDir) {
    await page.screenshot({ path: join(shotsDir, `${state.replace(/\W+/g, '-')}.png`), fullPage: true });
  }
  const results = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
  const summary = results.violations.flatMap((violation) =>
    violation.nodes.map((node) => `${node.target.join(' ')} -- ${(node.failureSummary ?? '').replace(/\s+/g, ' ')}`),
  );
  expect(summary, `color-contrast violations in state "${state}"`).toEqual([]);

  // Guard against a vacuous pass: axe must actually have evaluated text nodes.
  const evaluated = [...results.passes, ...results.incomplete].flatMap((rule) => rule.nodes).length;
  expect(evaluated, `axe evaluated no text in state "${state}"`).toBeGreaterThan(0);
}

export async function addCombatant(
  page: Page,
  c: { name: string; type: 'player' | 'enemy' | 'npc'; initiative: number; hp: number; ac: number; faction?: string },
): Promise<void> {
  await page.getByTestId('add-combatant-btn').click();
  const modal = page.locator('.modal');
  await modal.locator('label:has-text("Name:") + input').fill(c.name);
  await modal.locator('label:has-text("Type:") + select').selectOption(c.type);
  await modal.locator('label:has-text("Initiative:") + input').fill(String(c.initiative));
  await modal.locator('label:has-text("Max HP:") + input').fill(String(c.hp));
  await modal.locator('label:has-text("Armor Class:") + input').fill(String(c.ac));
  if (c.faction) {
    await modal.locator('label:has-text("Faction:") + input').fill(c.faction);
  }
  await modal.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(modal).toBeHidden();
}

/**
 * Adds a campaign character through the "Campaign character" dropdown in Add Combatant.
 * `label` is the option text, e.g. "Fixture Hero (player)".
 */
export async function addFromRoster(page: Page, label: string, initiative = 10): Promise<void> {
  await page.getByTestId('add-combatant-btn').click();
  const modal = page.locator('.modal');
  await modal.getByTestId('roster-select').selectOption({ label });
  await modal.getByTestId('combatant-initiative').fill(String(initiative));
  await modal.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(modal).toBeHidden();
}

/** Loads the app and waits until the backend is ready and the first encounter exists. */
export async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('mode-badge')).toBeVisible();
  await expect(page.getByTestId('add-combatant-btn')).toBeEnabled();
}

/** The full owner sign-in through the real UI: email, then the code via the development helper. */
export async function signInAsOwner(page: Page): Promise<void> {
  await page.getByTestId('sign-in-btn').click();
  await page.getByTestId('login-email').fill(OWNER_EMAIL);
  await page.getByTestId('login-send').click();
  await expect(page.getByTestId('login-neutral')).toBeVisible();
  await page.getByTestId('login-dev-fill').click();
  await expect(page.getByTestId('login-code')).toHaveValue(/^\d{6}$/);
  await page.getByTestId('login-verify').click();
  await expect(page.getByTestId('login-dialog')).toBeHidden();
  await expect(page.getByTestId('mode-badge')).toHaveText('Owner');
}

/** Applies 5 Fire damage to the named combatant through the Manage Combatant dialog. */
export async function damage(page: Page, targetName: string, amount = 5): Promise<void> {
  await page.locator('.combatant', { hasText: targetName }).click();
  await page.getByTestId('open-damage-modal-btn').click();
  const modal = page.locator('.modal');
  await modal.locator('.row input[type="number"]').first().fill(String(amount));
  await modal.locator('.row select').first().selectOption('Fire');
  await modal.getByRole('button', { name: 'Save Changes' }).click();
}
