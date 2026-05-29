// HallMate — Mobile responsive tests.
//
// These tests run cross-viewport without auth. They verify the public
// pages stay aligned and free of horizontal overflow at small widths.

import { test, expect } from './_fixtures.js';

const MOBILE_WIDTHS = [360, 390, 412];

async function hasHorizontalOverflow(page) {
  return page.evaluate(() => {
    return document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
  });
}

test.describe('Mobile — public pages have no horizontal overflow', () => {
  for (const width of MOBILE_WIDTHS) {
    test(`landing page at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/index.html');
      expect(await hasHorizontalOverflow(page)).toBeFalsy();
    });

    test(`login page at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/login.html');
      expect(await hasHorizontalOverflow(page)).toBeFalsy();
    });

    test(`contact page at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/contact.html');
      expect(await hasHorizontalOverflow(page)).toBeFalsy();
    });
  }
});

test.describe('Mobile — navbar alignment', () => {
  test('logged-out: logo left, Sign in right (no hamburger)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto('/index.html');

    const brand    = page.locator('#hm-brand-link');
    const signIn   = page.locator('.hm-nav-cta[data-auth="logged-out"] a');

    await expect(brand).toBeVisible();
    await expect(signIn).toBeVisible();
    // Hamburger removed — confirm it no longer exists in the DOM.
    await expect(page.locator('#hm-nav-toggle')).toHaveCount(0);

    // Sign in sits to the right of the logo
    const brandBox  = await brand.boundingBox();
    const signInBox = await signIn.boundingBox();
    expect(signInBox.x).toBeGreaterThan(brandBox.x);
  });
});

test.describe('Mobile — touch target sizing', () => {
  test('Send OTP button is ≥ 44px tall', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto('/login.html');

    const btn = page.locator('#hm-send-otp');
    const box = await btn.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
  });

  test('Contact page CTA buttons are full-width on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto('/contact.html');

    const phoneCta = page.locator('a[href^="tel:"]').first();
    await expect(phoneCta).toBeVisible();
    const box = await phoneCta.boundingBox();
    // Container is max 640px and col-12 → button should span most of the viewport
    expect(box.width).toBeGreaterThan(280);
  });
});

test.describe('Mobile — contact page layout', () => {
  test('Phone + Email cards stack vertically at 360px', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 900 });
    await page.goto('/contact.html');

    const phoneCard = page.locator('.hm-card').filter({ hasText: 'Call support' });
    const emailCard = page.locator('.hm-card').filter({ hasText: 'Email support' });

    const phoneBox = await phoneCard.boundingBox();
    const emailBox = await emailCard.boundingBox();

    // Email card should sit BELOW the phone card on mobile
    expect(emailBox.y).toBeGreaterThan(phoneBox.y + phoneBox.height - 10);
  });

  test('Phone + Email cards sit side-by-side at desktop width', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.goto('/contact.html');

    const phoneCard = page.locator('.hm-card').filter({ hasText: 'Call support' });
    const emailCard = page.locator('.hm-card').filter({ hasText: 'Email support' });

    const phoneBox = await phoneCard.boundingBox();
    const emailBox = await emailCard.boundingBox();

    // Same row → similar y, email to the right of phone
    expect(Math.abs(emailBox.y - phoneBox.y)).toBeLessThan(20);
    expect(emailBox.x).toBeGreaterThan(phoneBox.x);
  });
});
