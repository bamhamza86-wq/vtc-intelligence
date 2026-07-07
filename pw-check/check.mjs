import { chromium } from 'playwright';

const BASE = 'http://localhost:5555';

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  geolocation: { latitude: 48.8566, longitude: 2.3522 },
  permissions: ['geolocation'],
});
const page = await context.newPage();

// Login via UI
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);

// Try login form
const userInput = page.locator('input[type="text"], input[name="username"]').first();
const passInput = page.locator('input[type="password"]').first();
if (await userInput.count() > 0) {
  await userInput.fill('root');
  await passInput.fill('12345678');
  const loginBtn = page.locator('button[type="submit"], button:has-text("Se connecter")').first();
  await loginBtn.click();
  await page.waitForTimeout(2000);
}

await page.screenshot({ path: '/home/user/workspace/vtc-intelligence/pw-check/01_after_login.png', fullPage: true });

// Check onboarding overlay presence
const onboarding = page.locator('[data-testid="onboarding-coach-overlay"]');
const onboardingVisible = await onboarding.count() > 0 && await onboarding.isVisible().catch(() => false);
console.log('ONBOARDING_VISIBLE:', onboardingVisible);
if (onboardingVisible) {
  await page.screenshot({ path: '/home/user/workspace/vtc-intelligence/pw-check/02_onboarding.png', fullPage: true });
  // dismiss it to continue navigation
  const skipBtn = page.locator('[data-testid="button-onboarding-skip"]');
  if (await skipBtn.count() > 0) {
    await skipBtn.click();
    await page.waitForTimeout(500);
  }
}

// Navigate to economics
await page.goto(`${BASE}/#/economics`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await page.screenshot({ path: '/home/user/workspace/vtc-intelligence/pw-check/03_economics.png', fullPage: true });

const bodyText = await page.textContent('body');
const hasFrenchBenchmarkText = /chauffeurs comme vous|comparatif|agrégat statistique/i.test(bodyText || '');
console.log('BENCHMARK_TEXT_FOUND:', hasFrenchBenchmarkText);

// Check specific card via testid patterns if present
const peerCard = await page.locator('text=/chauffeurs comme vous/i').count();
console.log('PEER_CARD_MATCHES:', peerCard);

await browser.close();
