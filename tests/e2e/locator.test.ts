import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { resolveLocator } from '../../src/browser/locator.js';

test('resolveLocator supports label/placeholder/alt/title prefixes, exact and regex', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <label for="email-field">Email address</label>
      <input id="email-field" value="label-target">
      <input placeholder="Search products" value="placeholder-target">
      <img alt="Company logo" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
      <button title="Close dialog">X</button>
    `);

    await resolveLocator(page, 'label="Email address"').fill('via-exact-label');
    assert.equal(await page.locator('#email-field').inputValue(), 'via-exact-label');

    await resolveLocator(page, 'label=/e-?mail/i').fill('via-regex-label');
    assert.equal(await page.locator('#email-field').inputValue(), 'via-regex-label');

    await resolveLocator(page, 'placeholder="Search products"').fill('via-placeholder');
    assert.equal(await page.locator('[placeholder="Search products"]').inputValue(), 'via-placeholder');

    assert.equal(await resolveLocator(page, 'alt="Company logo"').count(), 1);
    assert.equal(await resolveLocator(page, 'alt=/company/i').count(), 1);

    assert.equal(await resolveLocator(page, 'title="Close dialog"').count(), 1);
  } finally {
    await browser.close();
  }
});

test('resolveLocator applies the same prefixes inside an iframe via frame=', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <iframe title="Payment" srcdoc="<label for='card'>Card number</label><input id='card'>"></iframe>
    `);
    await page.frameLocator('iframe[title="Payment"]').locator('#card').waitFor();

    await resolveLocator(page, 'frame=iframe[title="Payment"] >> label="Card number"').fill('4242');
    assert.equal(await page.frameLocator('iframe[title="Payment"]').locator('#card').inputValue(), '4242');
  } finally {
    await browser.close();
  }
});
