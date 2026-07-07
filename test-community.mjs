// Test QA — Couche Communautaire : login -> map, toggle heatmap, screenshot mobile, aggregation 2 sessions
import { chromium } from 'playwright';
import fs from 'fs';

const BASE = 'http://127.0.0.1:5000';
const results = { steps: [], errors: [] };

function log(msg) { console.log(msg); results.steps.push(msg); }

async function main() {
  const browser = await chromium.launch({ headless: true });

  // ---- 1. Desktop: login -> /map, toggle heatmap ----
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') results.errors.push('console:' + m.text()); });
  page.on('pageerror', (e) => results.errors.push('pageerror:' + e.message));

  await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
  log('Loaded /login, title=' + await page.title());

  // fill login form - try common selectors
  const userSel = await page.locator('input[name="username"], input#username, input[type="text"]').first();
  const passSel = await page.locator('input[name="password"], input#password, input[type="password"]').first();
  await userSel.fill('root');
  await passSel.fill('12345678');
  await page.screenshot({ path: '/tmp/qa_01_login.png' });

  const submitBtn = page.locator('button[type="submit"], button:has-text("Connexion"), button:has-text("Se connecter")').first();
  await submitBtn.click();
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  log('After login, url=' + page.url());
  await page.screenshot({ path: '/tmp/qa_02_after_login.png' });
  // App lands on /map (or similar) directly post-login via SPA hash router — do NOT page.goto (would wipe in-memory auth token)
  log('Post-login landing IS the map view (SPA), url=' + page.url());
  await page.screenshot({ path: '/tmp/qa_03_map.png' });

  // toggle heatmap
  const heatBtn = page.locator('[data-testid="button-toggle-community-heat"]');
  const heatBtnCount = await heatBtn.count();
  log('heatmap toggle button found: ' + heatBtnCount);
  if (heatBtnCount > 0) {
    await heatBtn.click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: '/tmp/qa_04_heatmap_on.png' });
    log('Clicked heatmap toggle, screenshot taken');
  }

  // check AvoidZonesCard presence
  const avoidCard = page.locator('[data-testid="avoid-zones-card"]');
  log('avoid-zones-card found: ' + (await avoidCard.count()));

  await ctx.close();

  // ---- 2. Mobile screenshot 375x812 ----
  const mobileCtx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const mpage = await mobileCtx.newPage();
  await mpage.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
  await mpage.locator('input[name="username"], input#username, input[type="text"]').first().fill('root');
  await mpage.locator('input[name="password"], input#password, input[type="password"]').first().fill('12345678');
  await mpage.locator('button[type="submit"], button:has-text("Connexion"), button:has-text("Se connecter")').first().click();
  await mpage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await mpage.waitForTimeout(1500); // SPA lands on map view directly — no page.goto (would wipe in-memory token)
  await mpage.screenshot({ path: '/tmp/qa_05_mobile_375x812.png' });
  log('Mobile screenshot 375x812 taken at map view, url=' + mpage.url());

  // toggle heatmap on mobile too
  const mHeatBtn = mpage.locator('[data-testid="button-toggle-community-heat"]');
  if (await mHeatBtn.count() > 0) {
    await mHeatBtn.click();
    await mpage.waitForTimeout(1500);
    await mpage.screenshot({ path: '/tmp/qa_06_mobile_heatmap_on.png' });
    log('Mobile heatmap toggled + screenshot taken');
  }

  // Try opening a zone popup to see ZoneChat
  const zoneMarkers = mpage.locator('.leaflet-marker-icon, .leaflet-interactive');
  const zCount = await zoneMarkers.count();
  log('Zone markers/interactive elements found on mobile map: ' + zCount);
  if (zCount > 0) {
    try {
      await zoneMarkers.first().click({ timeout: 5000 });
      await mpage.waitForTimeout(1000);
      await mpage.screenshot({ path: '/tmp/qa_07_zone_popup.png' });
      log('Clicked a zone marker, screenshot taken (ZoneChat expected)');
    } catch (e) {
      log('Could not click zone marker: ' + e.message);
    }
  }

  await mobileCtx.close();

  // ---- 3. ProfilePage reputation badge (in-app nav only, no page.goto — token is memory-only) ----
  const ctx3 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page3 = await ctx3.newPage();
  await page3.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
  await page3.locator('input[name="username"], input#username, input[type="text"]').first().fill('root');
  await page3.locator('input[name="password"], input#password, input[type="password"]').first().fill('12345678');
  await page3.locator('button[type="submit"], button:has-text("Connexion"), button:has-text("Se connecter")').first().click();
  await page3.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page3.waitForTimeout(1500);
  // Click "Plus" menu button, then "Profil" link inside it
  const plusBtn = page3.locator('button:has-text("Plus")').first();
  if (await plusBtn.count() > 0) {
    await plusBtn.click();
    await page3.waitForTimeout(600);
    const profilLink = page3.locator('a:has-text("Profil"), [href="/profile"], text=Profil').first();
    if (await profilLink.count() > 0) {
      await profilLink.click();
      await page3.waitForTimeout(1200);
    } else {
      log('Profil link not found inside Plus menu');
    }
  } else {
    log('Plus button not found');
  }
  log('Profile nav attempt, url=' + page3.url());
  await page3.screenshot({ path: '/tmp/qa_08_profile.png' });
  const repBadge = page3.locator('[data-testid="reputation-badge"]');
  log('reputation-badge found on profile: ' + (await repBadge.count()));
  await ctx3.close();

  await browser.close();

  fs.writeFileSync('/tmp/qa_results.json', JSON.stringify(results, null, 2));
  console.log('=== DONE ===');
  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
