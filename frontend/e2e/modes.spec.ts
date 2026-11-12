import { expect, Page, test } from '@playwright/test';
import {
  OWNER_EMAIL,
  addCombatant,
  addFromRoster,
  damage,
  expectNoContrastViolations,
  openApp,
  signInAsOwner,
} from './helpers';

// The backend runs with ENV=development and FAKE_AI=1 (see playwright.config.ts): codes come from
// the development helper, and the "narrator" echoes the prompt it was given, so the narration on
// screen shows exactly which lore reached the model.
const CAMPAIGN_ID = 'test-campaign';
const SENTINEL = 'SENTINEL_LORE_7Q2'; // planted in the fixture campaign's Amber Quill Chancery lore
const OTHER_SENTINEL = 'SENTINEL_LORE_OTHER_FACTION'; // a different faction's lore, same campaign

// Picking a campaign starts an EMPTY encounter: nobody is added for the owner. Its characters are a
// dropdown in Add Combatant (see addFromRoster).
async function pickCampaign(page: Page): Promise<void> {
  await page.getByTestId('campaign-select').selectOption(CAMPAIGN_ID);
  await expect(page.getByTestId('campaign-select')).toHaveValue(CAMPAIGN_ID);
  await expect(page.getByTestId('empty-state')).toContainText('choose characters from');
}

test.describe('anonymous mode', () => {
  test('shows the Anonymous badge, offers sign-in, has no campaign switcher and no campaign access', async ({ page }) => {
    await openApp(page);

    await expect(page.getByTestId('mode-badge')).toHaveText('Anonymous');
    await expect(page.getByTestId('sign-in-btn')).toBeVisible();
    await expect(page.getByTestId('sign-out-btn')).toHaveCount(0);
    await expect(page.locator('app-campaign-switcher')).toHaveCount(0);
    await expect(page.getByTestId('campaign-select')).toHaveCount(0);
    await expect(page.locator('.combatant')).toHaveCount(0); // the blank starting encounter has no demo roster
    await expectNoContrastViolations(page, '11 anonymous header');

    expect((await page.request.get('/api/campaigns')).status()).toBe(401);
    expect((await page.request.get(`/api/campaigns/${CAMPAIGN_ID}/roster`)).status()).toBe(401);
  });

  test('narration gets the public rules but none of the campaign lore', async ({ page }) => {
    await openApp(page);
    await addCombatant(page, { name: 'Amber Quill Guard', type: 'enemy', initiative: 10, hp: 20, ac: 13, faction: 'amber_quill_chancery' });

    await damage(page, 'Amber Quill Guard');

    const stream = page.locator('.stream');
    await expect(stream).toContainText('--- RULES ---');
    const narration = await stream.innerText();
    expect(narration).not.toContain(SENTINEL);
    expect(narration).not.toContain(OTHER_SENTINEL);
    expect(narration).toMatch(/--- LORE ---\s*--- RULES ---/); // the lore section is empty
  });

  test('an anonymous user cannot reach campaign encounters by guessing', async ({ page }) => {
    await openApp(page);

    expect((await page.request.get('/api/encounters/enc_00000000000000000000000000000000')).status()).toBe(404);
    expect((await page.request.post('/api/encounters', { data: { campaign_id: CAMPAIGN_ID } })).status()).toBe(403);
  });
});

test.describe('owner sign-in', () => {
  test('email, then code: the dialog says the same neutral thing for everyone, and signs the owner in', async ({ page }) => {
    await openApp(page);
    await page.getByTestId('sign-in-btn').click();
    await expect(page.getByTestId('login-dialog')).toBeVisible();
    await expectNoContrastViolations(page, '12 login step 1');

    await page.getByTestId('login-email').fill(OWNER_EMAIL);
    await page.getByTestId('login-send').click();
    await expect(page.getByTestId('login-neutral')).toHaveText('If this email is authorized, a code was sent.');
    await expect(page.getByTestId('login-code')).toHaveAttribute('autocomplete', 'one-time-code');
    await expectNoContrastViolations(page, '13 login step 2');

    await page.getByTestId('login-dev-fill').click();
    await expect(page.getByTestId('login-code')).toHaveValue(/^\d{6}$/);
    await page.getByTestId('login-verify').click();

    await expect(page.getByTestId('mode-badge')).toHaveText('Owner');
    await expect(page.getByTestId('sign-out-btn')).toBeVisible();
    await expect(page.getByTestId('sign-in-btn')).toHaveCount(0);
  });

  test('a stranger gets the very same message and nothing to sign in with', async ({ page }) => {
    await openApp(page);
    await page.getByTestId('sign-in-btn').click();

    await page.getByTestId('login-email').fill('stranger@example.test');
    await page.getByTestId('login-send').click();

    await expect(page.getByTestId('login-neutral')).toHaveText('If this email is authorized, a code was sent.');
    await page.getByTestId('login-dev-fill').click(); // the development helper has no code for a stranger
    await expect(page.getByTestId('login-message')).toContainText('No development code');
    await expect(page.getByTestId('login-code')).toHaveValue('');
  });

  test('five wrong codes use the attempt up: even the right code is then refused', async ({ page }) => {
    await openApp(page);
    await page.getByTestId('sign-in-btn').click();
    await page.getByTestId('login-email').fill(OWNER_EMAIL);
    await page.getByTestId('login-send').click();
    await expect(page.getByTestId('login-neutral')).toBeVisible();
    const issued = (await (await page.request.get(`/api/auth/dev/last-code?email=${OWNER_EMAIL}`)).json()).code as string;
    const wrong = issued === '111111' ? '222222' : '111111';

    for (let attempt = 1; attempt <= 5; attempt++) {
      await page.getByTestId('login-code').fill(wrong);
      await page.getByTestId('login-verify').click();
      await expect(page.getByTestId('login-message')).toContainText('not valid or has expired');
    }
    await expectNoContrastViolations(page, '14 login error message');

    await page.getByTestId('login-code').fill(issued);
    await page.getByTestId('login-verify').click();

    await expect(page.getByTestId('login-message')).toContainText('not valid or has expired');
    await expect(page.getByTestId('mode-badge')).toHaveText('Anonymous');
  });

  test('Escape closes the dialog', async ({ page }) => {
    await openApp(page);
    await page.getByTestId('sign-in-btn').click();
    await expect(page.getByTestId('login-dialog')).toBeVisible();

    await page.getByTestId('login-email').press('Escape');

    await expect(page.getByTestId('login-dialog')).toBeHidden();
  });
});

test.describe('owner mode', () => {
  test('the switcher lists the campaign; picking it adds nobody, and its characters are a dropdown in Add Combatant', async ({ page }) => {
    await openApp(page);
    await signInAsOwner(page);

    const select = page.getByTestId('campaign-select');
    await expect(select).toBeVisible();
    await expect(select.locator('option')).toHaveText(['No campaign (blank encounter)', 'Test Campaign']);
    await expectNoContrastViolations(page, '15 owner header with the campaign switcher');

    await pickCampaign(page);
    await expect(page.locator('.combatant')).toHaveCount(0); // nobody was added for the owner
    await expect(page.getByTestId('switch-confirm')).toHaveCount(0); // and there was nothing to ask about

    await page.getByTestId('add-combatant-btn').click();
    const roster = page.getByTestId('roster-select');
    await expect(roster.locator('option')).toHaveText([
      '-- Custom enemy / NPC --',
      'Fixture Hero (player)',
      'Amber Quill Guard (enemy)',
    ]);

    await roster.selectOption({ label: 'Fixture Hero (player)' });
    await expect(page.getByTestId('combatant-name')).toHaveValue('Fixture Hero');
    await expect(page.getByTestId('combatant-name')).toBeDisabled(); // a known character, not retyped
    await expect(page.getByTestId('combatant-type')).toBeDisabled();
    await expectNoContrastViolations(page, '20 add combatant: a campaign character picked');

    // The stats in roster.yaml are placeholders: every one can be corrected right here.
    await expect(page.getByTestId('combatant-ac')).toHaveValue('16');
    await expect(page.getByTestId('combatant-max-hp')).toHaveValue('40');
    await expect(page.getByTestId('combatant-current-hp')).toHaveValue('40');
    await page.getByTestId('combatant-ac').fill('18');
    await page.getByTestId('combatant-max-hp').fill('45');
    await expect(page.getByTestId('combatant-current-hp')).toHaveValue('45'); // follows max for a healthy character
    await page.getByTestId('combatant-current-hp').fill('30'); // ...and can start wounded
    await page.getByTestId('combatant-initiative').fill('12');
    await page.locator('.modal').getByRole('button', { name: 'Add', exact: true }).click();

    await expect(page.locator('.combatant')).toHaveCount(1);
    const hero = page.locator('.combatant', { hasText: 'Fixture Hero' });
    await expect(hero).toContainText('Init: 12');
    await expect(hero).toContainText('AC: 18');
    await expect(hero).toContainText('HP: 30 / 45');

    await page.getByTestId('add-combatant-btn').click(); // each character can be added once
    await expect(page.getByTestId('roster-select').locator('option')).toHaveText([
      '-- Custom enemy / NPC --',
      'Amber Quill Guard (enemy)',
    ]);
  });

  test('narration for a campaign encounter carries that campaign\'s lore, and only the target\'s faction', async ({ page }) => {
    await openApp(page);
    await signInAsOwner(page);
    await pickCampaign(page);
    await addFromRoster(page, 'Amber Quill Guard (enemy)');

    await damage(page, 'Amber Quill Guard');

    const stream = page.locator('.stream');
    await expect(stream).toContainText(SENTINEL);
    await expect(stream).toContainText('--- RULES ---');
    expect(await stream.innerText()).not.toContain(OTHER_SENTINEL);
  });

  test('switching away from a table with people on it asks inline, never with window.confirm', async ({ page }) => {
    const dialogs: string[] = [];
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    await openApp(page);
    await signInAsOwner(page);
    await pickCampaign(page);
    await addFromRoster(page, 'Fixture Hero (player)');
    await addFromRoster(page, 'Amber Quill Guard (enemy)', 5);
    await page.getByTestId('start-combat-btn').click();
    await expect(page.getByTestId('next-turn-btn')).toBeVisible();
    const select = page.getByTestId('campaign-select');

    await select.selectOption('');
    await expect(page.getByTestId('switch-confirm')).toContainText('Switch to a blank encounter?');
    await expectNoContrastViolations(page, '16 switch confirmation');
    await page.getByTestId('switch-confirm-no').click();

    await expect(page.getByTestId('switch-confirm')).toHaveCount(0);
    await expect(page.locator('.combatant')).toHaveCount(2); // untouched
    await expect(select).toHaveValue(CAMPAIGN_ID);

    await select.selectOption('');
    await page.getByTestId('switch-confirm-yes').click();

    await expect(page.locator('.combatant')).toHaveCount(0);
    await expect(select).toHaveValue('');
    expect(dialogs).toEqual([]);
  });

  test('even before combat starts, anyone added is worth a question; an empty table is not', async ({ page }) => {
    await openApp(page);
    await signInAsOwner(page);
    const select = page.getByTestId('campaign-select');
    await pickCampaign(page);

    await select.selectOption(''); // nothing at the table: leave freely
    await expect(page.getByTestId('switch-confirm')).toHaveCount(0);
    await expect(select).toHaveValue('');

    await pickCampaign(page);
    await addFromRoster(page, 'Fixture Hero (player)'); // one person is enough
    await select.selectOption('');

    await expect(page.getByTestId('switch-confirm')).toBeVisible();
  });

  test('a reload keeps the session and restores the remembered campaign, with its characters to pick from', async ({ page }) => {
    await openApp(page);
    await signInAsOwner(page);
    await pickCampaign(page);

    await page.reload();

    await expect(page.getByTestId('mode-badge')).toHaveText('Owner');
    await expect(page.getByTestId('campaign-select')).toHaveValue(CAMPAIGN_ID);
    await expect(page.locator('.combatant')).toHaveCount(0);
    await page.getByTestId('add-combatant-btn').click();
    await expect(page.getByTestId('roster-select').locator('option')).toHaveCount(3);
  });

  test('signing out returns to a blank anonymous encounter and locks the campaigns again', async ({ page }) => {
    await openApp(page);
    await signInAsOwner(page);
    await pickCampaign(page);

    await page.getByTestId('sign-out-btn').click();

    await expect(page.getByTestId('mode-badge')).toHaveText('Anonymous');
    await expect(page.getByTestId('campaign-select')).toHaveCount(0);
    await expect(page.locator('.combatant')).toHaveCount(0);
    expect((await page.request.get('/api/campaigns')).status()).toBe(401);
  });

  test('a campaign encounter is invisible to anyone without the session', async ({ page, browser }) => {
    await openApp(page);
    await signInAsOwner(page);
    const created = page.waitForResponse((r) => r.url().endsWith('/api/encounters') && r.request().method() === 'POST');
    await page.getByTestId('campaign-select').selectOption(CAMPAIGN_ID);
    const encounterId = (await (await created).json()).encounter_id as string;
    await expect(page.getByTestId('empty-state')).toContainText('choose characters from');

    expect((await page.request.get(`/api/encounters/${encounterId}`)).status()).toBe(200);
    const stranger = await browser.newContext({ baseURL: page.url() });
    const response = await stranger.request.get(`/api/encounters/${encounterId}`);
    await stranger.close();

    expect(response.status()).toBe(404);
  });
});

test.describe('no unknown combatants', () => {
  test('anonymous: Add stays disabled until the combatant has a name, and nobody called Unknown ever appears', async ({ page }) => {
    await openApp(page);
    await page.getByTestId('add-combatant-btn').click();
    const add = page.locator('.modal').getByRole('button', { name: 'Add', exact: true });

    await expect(add).toBeDisabled();
    await expect(page.getByTestId('add-blocked-reason')).toContainText('Enter a name');
    await expectNoContrastViolations(page, '21 add combatant: a name is required');

    await page.getByTestId('combatant-name').fill('   '); // spaces are not a name
    await expect(add).toBeDisabled();

    await page.getByTestId('combatant-name').fill('Goblin');
    await expect(add).toBeEnabled();
    await expect(page.getByTestId('add-blocked-reason')).toHaveCount(0);
    await add.click();

    await expect(page.locator('.combatant')).toHaveCount(1);
    await expect(page.locator('.combatant')).toContainText('Goblin');
    await expect(page.locator('body')).not.toContainText('Unknown');
  });

  test('in a campaign, players come only from the dropdown; a named custom enemy is still fine', async ({ page }) => {
    await openApp(page);
    await signInAsOwner(page);
    await pickCampaign(page);
    await page.getByTestId('add-combatant-btn').click();

    await expect(page.getByTestId('combatant-type').locator('option')).toHaveText(['Enemy', 'NPC']); // no Player
    await expect(page.getByTestId('combatant-template').locator('option')).toHaveText(['-- Custom --', 'Enemy']);
    const add = page.locator('.modal').getByRole('button', { name: 'Add', exact: true });
    await expect(add).toBeDisabled(); // custom needs a name

    await page.getByTestId('combatant-name').fill('Bandit');
    await expect(add).toBeEnabled();
    await add.click();

    await expect(page.locator('.combatant')).toHaveCount(1);
    await expect(page.locator('.combatant', { hasText: 'Bandit' })).toContainText('(enemy)');
  });
});

test.describe('a session that ends', () => {
  test('owner-only call: the table resets to anonymous and asks for sign-in again', async ({ page, context }) => {
    await openApp(page);
    await signInAsOwner(page);
    await pickCampaign(page);
    await context.clearCookies(); // the session is gone behind the app's back

    await page.getByRole('button', { name: 'New Encounter' }).click();
    await page.getByRole('button', { name: 'Start New Encounter' }).click(); // reloads the roster: owner-only

    await expect(page.getByTestId('login-dialog')).toBeVisible();
    await expect(page.getByTestId('login-expired')).toBeVisible();
    await expect(page.getByTestId('mode-badge')).toHaveText('Anonymous');
    await expect(page.locator('.combatant')).toHaveCount(0);
    await expectNoContrastViolations(page, '17 session ended: login prompt');

    await page.getByTestId('login-cancel').click();
    await expect(page.getByTestId('session-expired-banner')).toBeVisible();
    await expectNoContrastViolations(page, '18 session ended: banner');
  });

  test('an ordinary save: the 404 is recognised as a lost session, not a lost encounter', async ({ page, context }) => {
    await openApp(page);
    await signInAsOwner(page);
    await pickCampaign(page);
    await context.clearCookies();

    // Saving a new combatant is a PUT on the owner-scoped encounter: with no session the server
    // answers 404 (never 401, so a private encounter cannot be probed). The app must work out
    // from /auth/me that this means "session ended", not "encounter vanished".
    await page.getByTestId('add-combatant-btn').click();
    await page.locator('.modal').first().locator('label:has-text("Name:") + input').fill('Late Arrival');
    await page.locator('.modal').first().getByRole('button', { name: 'Add', exact: true }).click();

    await expect(page.getByTestId('login-expired')).toBeVisible();
    await expect(page.getByTestId('mode-badge')).toHaveText('Anonymous');
    await expect(page.locator('.combatant')).toHaveCount(0);
  });

  test('a failed save tells the user instead of failing silently', async ({ page }) => {
    await openApp(page);
    await addCombatant(page, { name: 'Goblin', type: 'enemy', initiative: 12, hp: 7, ac: 13 });
    await page.getByTestId('start-combat-btn').click();
    await page.route('**/api/encounters/*', (route) =>
      route.request().method() === 'PUT' ? route.fulfill({ status: 500, body: 'boom' }) : route.continue(),
    );

    await page.getByTestId('next-turn-btn').click();

    await expect(page.getByTestId('notice-banner')).toContainText('Could not update encounter');
    await expectNoContrastViolations(page, '19 notice banner');
  });
});
