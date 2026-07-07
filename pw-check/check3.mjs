import { chromium } from 'playwright';
const BASE = 'http://localhost:5555';
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
page.on('console', msg => console.log('BROWSER:', msg.text()));

await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.screenshot({ path: '/home/user/workspace/vtc-intelligence/pw-check/10_initial.png' });

const bodyText1 = await page.textContent('body');
console.log('HAS_LOGIN_FORM:', /se connecter|mot de passe/i.test(bodyText1||''));

const userInput = page.locator('input').first();
const passInput = page.locator('input[type="password"]').first();
console.log('input count:', await page.locator('input').count());

if (await passInput.count() > 0) {
  await userInput.fill('root');
  await passInput.fill('12345678');
  await page.screenshot({ path: '/home/user/workspace/vtc-intelligence/pw-check/11_filled.png' });
  const loginBtn = page.locator('button:has-text("Se connecter"), button[type="submit"]').first();
  await loginBtn.click();
  await page.waitForTimeout(2500);
}
await page.screenshot({ path: '/home/user/workspace/vtc-intelligence/pw-check/12_post_login.png', fullPage: true });

const onboarding = page.locator('[data-testid="onboarding-coach-overlay"]');
console.log('onboarding count:', await onboarding.count());
if (await onboarding.count() > 0) {
  console.log('ONBOARDING_VISIBLE:', await onboarding.isVisible());
  await page.screenshot({ path: '/home/user/workspace/vtc-intelligence/pw-check/13_onboarding.png', fullPage: true });
  const skip = page.locator('[data-testid="button-onboarding-skip"]');
  if (await skip.count() > 0) { await skip.click(); await page.waitForTimeout(500); }
}

await page.goto(`${BASE}/#/economics`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await page.screenshot({ path: '/home/user/workspace/vtc-intelligence/pw-check/14_economics.png', fullPage: true });
const bodyText2 = await page.textContent('body');
console.log('BENCHMARK_TEXT_FOUND:', /chauffeurs comme vous|comparatif|agrégat statistique/i.test(bodyText2||''));

await browser.close();
