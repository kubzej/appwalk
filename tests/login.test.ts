import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { login } from "../src/browser/login.js";

test("handles a form-less login panel with duplicate Sign In buttons", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route("https://app.test/", async (route) => {
      await route.fulfill({
        contentType: "text/html",
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

    const result = await login(page, "https://app.test/", "standard_user", "secret");

    assert.equal(page.url(), "https://app.test/catalog");
    assert.match(result.snapshot, /Catalog/);
  } finally {
    await browser.close();
  }
});
