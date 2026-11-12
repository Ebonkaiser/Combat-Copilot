import { expect, test } from '@playwright/test';
import { expectNoContrastViolations, openApp } from './helpers';
import { TOTP_SECRET, TOTP_WEB_PORT } from './stack';
import { claimFreshCode, codeForStep, invalidCode, markStepUsed, stepAt } from './totp-code';

// This spec runs against its own stack (see playwright.config.ts): the backend there has OWNER_TOTP_SECRET
// set, so sign-in asks for the code from an authenticator app instead of emailing one. The codes are
// computed here with Node's crypto -- an implementation independent of the server's Python.
test.use({ baseURL: `http://localhost:${TOTP_WEB_PORT}` });

// Both steps the server accepts at any moment are used by the two sign-ins below, so keep the number of
// successful sign-ins in this file at two (more would have to wait for the next 30-second step), and keep
// the lockout test LAST: it locks sign-in for fifteen minutes for the rest of this backend's life.

test('the reference implementation in this file matches RFC 4226 and RFC 6238', () => {
  expect(codeForStep(TOTP_SECRET, 0)).toBe('755224'); // RFC 4226 appendix D, counter 0
  // RFC 6238 appendix B (SHA-1), as 6 digits: Unix time -> code
  for (const [seconds, expected] of [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ] as const) {
    expect(codeForStep(TOTP_SECRET, Math.floor(seconds / 30)), `T=${seconds}`).toBe(expected);
  }
});

test.describe('owner sign-in with an authenticator app', () => {
  test('asks for the code from the app: no address, no email step, nothing sent', async ({ page }) => {
    const requested: string[] = [];
    page.on('request', (request) => requested.push(request.url()));
    await openApp(page);

    await page.getByTestId('sign-in-btn').click();

    await expect(page.getByTestId('login-dialog')).toBeVisible();
    await expect(page.getByTestId('login-totp-hint')).toContainText('authenticator app');
    await expect(page.getByTestId('login-code')).toBeFocused();
    await expect(page.getByTestId('login-code')).toHaveAttribute('autocomplete', 'one-time-code');
    await expect(page.getByTestId('login-email')).toHaveCount(0);
    await expect(page.getByTestId('login-send')).toHaveCount(0);
    await expectNoContrastViolations(page, '20 totp login dialog');
    expect(requested.filter((url) => url.includes('/auth/request-code'))).toEqual([]);
  });

  test('a wrong code gets one neutral answer, clears the field and signs nobody in', async ({ page }) => {
    await openApp(page);
    await page.getByTestId('sign-in-btn').click();

    await page.getByTestId('login-code').fill(invalidCode(TOTP_SECRET));
    await page.getByTestId('login-verify').click();

    await expect(page.getByTestId('login-message')).toContainText('not valid');
    await expect(page.getByTestId('login-message')).toContainText('authenticator app');
    await expect(page.getByTestId('login-code')).toHaveValue('');
    await expect(page.getByTestId('mode-badge')).toHaveText('Anonymous');
    await expectNoContrastViolations(page, '21 totp login error');
  });

  test('"Fill code (dev)" fills in a code the server accepts, and it signs the owner in', async ({ page }) => {
    await openApp(page);
    await page.getByTestId('sign-in-btn').click();
    const before = stepAt(Date.now());

    await page.getByTestId('login-dev-fill').click();
    await expect(page.getByTestId('login-code')).toHaveValue(/^\d{6}$/); // the helper answers asynchronously
    const filled = await page.getByTestId('login-code').inputValue();
    const after = stepAt(Date.now());

    // The helper hands out the current step's code (or the next one's, if the current one was used).
    const step = [before, after, before + 1, after + 1].find((candidate) => codeForStep(TOTP_SECRET, candidate) === filled);
    expect(step, 'the filled code is the right code for the current or the next step').toBeDefined();
    markStepUsed(step as number);
    await page.getByTestId('login-verify').click();

    await expect(page.getByTestId('login-dialog')).toBeHidden();
    await expect(page.getByTestId('mode-badge')).toHaveText('Owner');
  });

  test('the code from the app signs the owner in, a reload keeps the session, and the same code is refused afterwards', async ({ page }) => {
    const code = await claimFreshCode(TOTP_SECRET);
    await openApp(page);
    await page.getByTestId('sign-in-btn').click();
    await page.getByTestId('login-code').fill(code);
    await page.getByTestId('login-verify').click();

    await expect(page.getByTestId('login-dialog')).toBeHidden();
    await expect(page.getByTestId('mode-badge')).toHaveText('Owner');
    await expect(page.getByTestId('sign-out-btn')).toBeVisible();

    await page.reload();
    await expect(page.getByTestId('mode-badge')).toHaveText('Owner');

    await page.getByTestId('sign-out-btn').click();
    await expect(page.getByTestId('mode-badge')).toHaveText('Anonymous');

    // A code works once: typing the same one again is refused, however fresh it still looks.
    await page.getByTestId('sign-in-btn').click();
    await page.getByTestId('login-code').fill(code);
    await page.getByTestId('login-verify').click();
    await expect(page.getByTestId('login-message')).toContainText('not valid');
    await expect(page.getByTestId('mode-badge')).toHaveText('Anonymous');
  });

  test('too many wrong codes lock sign-in, and the dialog says for how long', async ({ page }) => {
    await openApp(page);

    // Production locks after five wrong codes in a row; a development server allows ten times as many.
    let locked = false;
    for (let attempt = 1; attempt <= 60 && !locked; attempt++) {
      const response = await page.request.post('/api/auth/verify', { data: { code: invalidCode(TOTP_SECRET) } });
      expect([401, 429]).toContain(response.status());
      locked = response.status() === 429;
    }
    expect(locked, 'sign-in locked within 60 wrong codes').toBe(true);
    const refused = await page.request.post('/api/auth/verify', { data: { code: invalidCode(TOTP_SECRET) } });
    expect(refused.headers()['retry-after']).toBe('900');

    await page.getByTestId('sign-in-btn').click();
    await page.getByTestId('login-code').fill(invalidCode(TOTP_SECRET));
    await page.getByTestId('login-verify').click();

    await expect(page.getByTestId('login-message')).toHaveText('Too many attempts. Try again in 15 minutes.');
    await expect(page.getByTestId('mode-badge')).toHaveText('Anonymous');
    await expectNoContrastViolations(page, '22 totp lockout message');
  });
});
