import type { Locator, Page } from 'playwright';
import { toStepResult } from './snapshot.js';
import type { StepResult } from '../types.js';
import type { Logger } from '../logging/logger.js';
import { LOGIN_CONTRACT } from './login-contract.js';

async function findByLabelOrRole(root: Page | Locator, ...patterns: RegExp[]): Promise<Locator | null> {
  for (const pattern of patterns) {
    const byLabel = root.getByLabel(pattern);
    if ((await byLabel.count()) > 0) return byLabel.first();
  }
  for (const pattern of patterns) {
    const byRole = root.getByRole('textbox', { name: pattern });
    if ((await byRole.count()) > 0) return byRole.first();
  }
  return null;
}

// English label text (getByLabel/getByRole "username"/"password"/"log in") only works on
// English-language UIs. HTML input types are language-independent — every site that masks
// password input must use type="password" regardless of UI language — so structural signals
// (input type, position within the form) are tried first, with English text as a fallback,
// not the other way around.
export async function login(
  page: Page,
  url: string,
  username: string,
  password: string,
  logger?: Logger,
): Promise<StepResult> {
  logger?.debug('auth.login_started', 'Login started', { url });
  await page.goto(url);
  const initialUrl = page.url();

  let passwordField = page.locator(LOGIN_CONTRACT.passwordSelector).first();
  if ((await passwordField.count()) === 0) {
    const loginTrigger = page
      .getByRole('button', { name: new RegExp(LOGIN_CONTRACT.triggerPattern, 'i') })
      .or(page.getByRole('link', { name: new RegExp(LOGIN_CONTRACT.triggerPattern, 'i') }))
      .first();
    if ((await loginTrigger.count()) > 0) {
      await loginTrigger.click();
      await passwordField.waitFor({ state: 'visible' });
    }
  }
  const loginPageUrl = page.url();
  if ((await passwordField.count()) === 0) {
    const byLabel = await findByLabelOrRole(page, /password/i);
    if (!byLabel) {
      logger?.debug('auth.login_form_not_found', 'No password field was found', { url: page.url() });
      throw new Error('Login form not found. Use --storage-state if the site uses SSO, 2FA, or has no password login.');
    }
    passwordField = byLabel;
  }

  const form = page.locator(LOGIN_CONTRACT.formSelector).first();
  const loginScope =
    (await form.count()) > 0
      ? form
      : passwordField.locator("xpath=ancestor::*[.//button or .//input[@type='submit']][1]");

  let usernameField = loginScope.locator(LOGIN_CONTRACT.usernameSelector).first();
  if ((await usernameField.count()) === 0) {
    const byLabel = await findByLabelOrRole(loginScope, /username/i, /e-?mail/i);
    if (byLabel) {
      usernameField = byLabel;
    } else {
      // Positional fallback: the username field is virtually always the text input
      // immediately preceding the password field in the same form, regardless of language.
      usernameField = loginScope.locator(LOGIN_CONTRACT.usernameFallbackSelector).first();
    }
  }

  await usernameField.fill(username);
  await passwordField.fill(password);

  const loginPattern = new RegExp(LOGIN_CONTRACT.triggerPattern, 'i');
  const localLoginButtons = loginScope.getByRole('button', { name: loginPattern });
  if ((await localLoginButtons.count()) > 0) {
    // Prefer the visible semantic control. Some SPA forms expose a submit button but
    // handle its click separately from native form submission.
    await localLoginButtons.last().click();
  } else {
    const formSubmit = loginScope.locator(LOGIN_CONTRACT.submitSelector).first();
    if ((await formSubmit.count()) > 0) {
      await formSubmit.click();
    } else {
      const pageLoginButtons = page.getByRole('button', { name: loginPattern });
      if ((await pageLoginButtons.count()) === 0) {
        throw new Error('Login submit control not found. Use --storage-state if the site uses a custom login flow.');
      }
      await pageLoginButtons.last().click();
    }
  }

  // SPA redirects can leave the login form mounted briefly after the submit succeeds. Wait for
  // either the URL or the password field to settle before the caller starts exploring or replaying.
  await Promise.race([
    page.waitForURL((nextUrl) => nextUrl.toString() !== loginPageUrl, { timeout: 10000 }),
    passwordField.waitFor({ state: 'hidden', timeout: 10000 }),
  ]).catch(() => undefined);

  let stillOnPasswordField = await page
    .locator(LOGIN_CONTRACT.passwordSelector)
    .first()
    .isVisible()
    .catch(() => false);
  if (stillOnPasswordField && page.url() !== loginPageUrl) {
    // A successful SPA redirect can commit the new route before React removes the old
    // login panel. Give that stale panel a moment to unmount before judging the result.
    await page
      .locator(LOGIN_CONTRACT.passwordSelector)
      .first()
      .waitFor({ state: 'hidden', timeout: 10000 })
      .catch(() => undefined);
    stillOnPasswordField = await page
      .locator(LOGIN_CONTRACT.passwordSelector)
      .first()
      .isVisible()
      .catch(() => false);
  }
  const finalPath = new URL(page.url()).pathname.toLowerCase();
  const remainsOnLoginRoute = new RegExp(LOGIN_CONTRACT.loginRoutePattern).test(finalPath);
  // A changed URL is not proof of authentication: some apps route failed submits to /login.
  // Do not start exploration until the login has at least left the login route and hidden the
  // password field. Otherwise the caller would explore a session whose auth state is unknown.
  if (stillOnPasswordField || page.url() === loginPageUrl || remainsOnLoginRoute) {
    const message = stillOnPasswordField
      ? 'Login did not complete. Check credentials or use --storage-state for 2FA, SSO, or CAPTCHA.'
      : 'Login outcome could not be verified. Use --storage-state if the app keeps the login route after authentication.';
    logger?.warn(message);
    logger?.debug('auth.login_rejected', 'Login did not reach an independently verifiable authenticated route', {
      url: page.url(),
      urlChanged: page.url() !== loginPageUrl,
      initialUrl,
      passwordVisible: stillOnPasswordField,
      remainsOnLoginRoute,
    });
    throw new Error(message);
  }

  logger?.debug('auth.login_succeeded', 'Login navigated to a non-login route', { url: page.url() });

  return toStepResult(page);
}
