import { mkdtempSync, rmSync } from 'node:fs';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { chromium } from 'playwright';
import { login } from '../../src/browser/login.js';
import { writeGeneratedSuite } from '../../src/cli/generated-suite.js';

async function loginFixturePage(browser: import('playwright').Browser) {
  const page = await browser.newPage();
  await page.route('https://app.test/', async (route) => {
    await route.fulfill({
      contentType: 'text/html',
      body: `
        <header><button id="nav-sign-in">Sign In</button></header>
        <main><p>Public home</p></main>
        <script>
          document.querySelector('#nav-sign-in').addEventListener('click', () => {
            history.pushState({}, '', '/login');
            document.body.innerHTML =
              '<header><button>Sign In</button></header>' +
              '<section aria-label="Login panel">' +
              '<label for="username">Username</label><input id="username" name="username">' +
              '<label for="password">Password</label><input id="password" name="password" type="password">' +
              '<button id="submit-login">Sign In</button></section>';
            document.querySelector('#submit-login').addEventListener('click', () => {
              history.pushState({}, '', '/catalog');
              document.body.innerHTML = '<main><h1>Catalog</h1></main>';
            });
          });
        </script>
      `,
    });
  });
  return page;
}

test('handles a form-less login panel with duplicate Sign In buttons', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('https://app.test/', async (route) => {
      await route.fulfill({
        contentType: 'text/html',
        body: `
          <header><button id="nav-sign-in">Sign In</button></header>
          <main><p>Public home</p></main>
          <script>
            document.querySelector('#nav-sign-in').addEventListener('click', () => {
              history.pushState({}, '', '/login');
              document.body.innerHTML =
                '<header><button>Sign In</button></header>' +
                '<section aria-label="Login panel">' +
                '<label for="username">Username</label><input id="username" name="username">' +
                '<label for="password">Password</label><input id="password" name="password" type="password">' +
                '<button id="submit-login">Sign In</button></section>';
              document.querySelector('#submit-login').addEventListener('click', () => {
                history.pushState({}, '', '/catalog');
                document.body.innerHTML = '<main><h1>Catalog</h1></main>';
              });
            });
          </script>
        `,
      });
    });

    const result = await login(page, 'https://app.test/', 'standard_user', 'secret');

    assert.equal(page.url(), 'https://app.test/catalog');
    assert.match(result.snapshot, /Catalog/);
  } finally {
    await browser.close();
  }
});

test('runtime and generated login helpers pass the same login contract', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'appwalk-login-contract-'));
  const browser = await chromium.launch({ headless: true });
  try {
    writeGeneratedSuite(directory, [{ name: 'Login', entries: [] }], {
      url: 'https://app.test/',
      username: 'standard_user',
      password: 'secret',
    });
    const generatedAuth = (await import(`${pathToFileURL(join(directory, 'auth.ts'))}?contract=${Date.now()}`)) as {
      loginWithConfiguredCredentials: (page: import('playwright').Page) => Promise<void>;
    };
    const runtimePage = await loginFixturePage(browser);
    const generatedPage = await loginFixturePage(browser);

    const result = await login(runtimePage, 'https://app.test/', 'standard_user', 'secret');
    // Unlike the runtime login(), the generated helper takes no url — a generated spec always
    // navigates itself (see src/codegen/spec.ts) before calling loginWithConfiguredCredentials.
    await generatedPage.goto('https://app.test/');
    await generatedAuth.loginWithConfiguredCredentials(generatedPage);

    assert.equal(runtimePage.url(), 'https://app.test/catalog');
    assert.equal(generatedPage.url(), runtimePage.url());
    assert.match(result.snapshot, /Catalog/);
  } finally {
    await browser.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
