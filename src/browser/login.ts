import type { Locator, Page } from "playwright";
import { toStepResult } from "./snapshot.js";
import type { StepResult } from "../types.js";
import type { Logger } from "../logging/logger.js";

async function findByLabelOrRole(page: Page, ...patterns: RegExp[]): Promise<Locator | null> {
  for (const pattern of patterns) {
    const byLabel = page.getByLabel(pattern);
    if ((await byLabel.count()) > 0) return byLabel.first();
  }
  for (const pattern of patterns) {
    const byRole = page.getByRole("textbox", { name: pattern });
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
  logger?.debug("auth.login_started", "Login started", { url });
  await page.goto(url);
  const loginUrl = page.url();

  let passwordField = page.locator('input[type="password"]').first();
  if ((await passwordField.count()) === 0) {
    const loginTrigger = page
      .getByRole("button", { name: /log ?in|sign ?in/i })
      .or(page.getByRole("link", { name: /log ?in|sign ?in/i }))
      .first();
    if ((await loginTrigger.count()) > 0) {
      await loginTrigger.click();
      await passwordField.waitFor({ state: "visible" });
    }
  }
  if ((await passwordField.count()) === 0) {
    const byLabel = await findByLabelOrRole(page, /password/i);
    if (!byLabel) {
      logger?.debug("auth.login_form_not_found", "No password field was found", { url: page.url() });
      throw new Error("Login form not found. Use --storage-state if the site uses SSO, 2FA, or has no password login.");
    }
    passwordField = byLabel;
  }

  let usernameField = page.locator('input[type="email"]').first();
  if ((await usernameField.count()) === 0) {
    const byLabel = await findByLabelOrRole(page, /username/i, /e-?mail/i);
    if (byLabel) {
      usernameField = byLabel;
    } else {
      // Positional fallback: the username field is virtually always the text input
      // immediately preceding the password field in the same form, regardless of language.
      const form = page.locator('form:has(input[type="password"])').first();
      usernameField = form.locator('input[type="text"], input:not([type])').first();
    }
  }

  await usernameField.fill(username);
  await passwordField.fill(password);

  const form = page.locator('form:has(input[type="password"])').first();
  const formSubmit = form.locator('button[type="submit"], input[type="submit"]').first();
  if ((await formSubmit.count()) > 0) {
    await formSubmit.click();
  } else {
    await page.getByRole("button", { name: /log ?in|sign ?in/i }).click();
  }

  // SPA redirects can leave the login form mounted briefly after the submit succeeds. Wait for
  // either the URL or the password field to settle before the caller starts exploring or replaying.
  await Promise.race([
    page.waitForURL((nextUrl) => nextUrl.toString() !== loginUrl, { timeout: 10000 }),
    passwordField.waitFor({ state: "hidden", timeout: 10000 }),
  ]).catch(() => undefined);

  const stillOnPasswordField = await page
    .locator('input[type="password"]')
    .first()
    .isVisible()
    .catch(() => false);
  const finalPath = new URL(page.url()).pathname.toLowerCase();
  const remainsOnLoginRoute = /(^|\/)login(?:\/|$)/.test(finalPath);
  // A changed URL is not proof of authentication: some apps route failed submits to /login.
  // Do not start exploration until the login has at least left the login route and hidden the
  // password field. Otherwise the caller would explore a session whose auth state is unknown.
  if (stillOnPasswordField || page.url() === loginUrl || remainsOnLoginRoute) {
    const message = stillOnPasswordField
      ? "Login did not complete. Check credentials or use --storage-state for 2FA, SSO, or CAPTCHA."
      : "Login outcome could not be verified. Use --storage-state if the app keeps the login route after authentication.";
    logger?.warn(message);
    logger?.debug("auth.login_rejected", "Login did not reach an independently verifiable authenticated route", {
      url: page.url(), urlChanged: page.url() !== loginUrl, passwordVisible: stillOnPasswordField, remainsOnLoginRoute,
    });
    throw new Error(message);
  }

  logger?.debug("auth.login_succeeded", "Login navigated to a non-login route", { url: page.url() });

  return toStepResult(page);
}
