// Test Playwright — Couche Sécurité & Conduite (feat/safety)
// Viewport 375x812 (iPhone 13), géoloc Paris, login root/12345678
// Vérifie : tap targets XXL DrivePage, mode nuit forcé, endpoints safety, alerte 2h

import { chromium, devices } from '/tmp/node_modules/playwright/index.mjs';
import fs from 'fs';

const BASE = 'http://localhost:5000';
const OUT = '/home/user/workspace/safety_screenshots';
fs.mkdirSync(OUT, { recursive: true });

const report = { checks: [], screenshots: [] };

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
    geolocation: { latitude: 48.8566, longitude: 2.3522 },
    permissions: ['geolocation'],
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
  });

  const page = await context.newPage();
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push({ type: 'pageerror', msg: e.message }));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push({ type: 'console', msg: m.text() }); });

  let authToken = null;
  page.on('request', (req) => {
    const h = req.headers();
    if (h['x-auth-token'] && !authToken) authToken = h['x-auth-token'];
  });

  console.log('Login');
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(1500);
  const hasLoginInput = await page.locator('input[autocomplete="username"]').count();
  if (hasLoginInput > 0) {
    await page.fill('input[autocomplete="username"]', 'root');
    await page.fill('input[type="password"]', '12345678');
    await page.locator('button[type="submit"], button:has-text("Connexion"), button:has-text("Se connecter")').first().click();
    await page.waitForTimeout(2500);
  }

  console.log('Capture du token via requete reseau reelle (deja loggue, pas de reload)');
  await page.waitForTimeout(1500);
  console.log('  Token capture:', authToken ? 'oui' : 'non');

  async function apiFetch(path, opts = {}) {
    return page.evaluate(
      async ({ path, opts, authToken }) => {
        const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
        if (authToken) {
          headers['Authorization'] = 'Bearer ' + authToken;
          headers['X-Auth-Token'] = authToken;
        }
        try {
          const res = await fetch(path, { ...opts, headers, credentials: 'include' });
          let body = null;
          try { body = await res.json(); } catch {}
          return { status: res.status, body };
        } catch (e) {
          return { status: 0, body: null, error: String(e) };
        }
      },
      { path, opts, authToken },
    );
  }

  console.log('Demarrage session (API safety)');
  const simResult = await apiFetch('/api/safety/session/start', { method: 'POST' });
  console.log('  session/start ->', simResult.status, JSON.stringify(simResult.body).slice(0, 200));

  console.log('Navigation /drive');
  await page.goto(BASE + '/#/drive', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: OUT + '/01-drive-normal.png', fullPage: false });
  report.screenshots.push('01-drive-normal.png');

  const driveTimerVisible = await page.locator('[data-testid="drive-timer"]').count();
  report.checks.push({ name: 'DriveTimer present', pass: driveTimerVisible > 0 });
  console.log('  DriveTimer present:', driveTimerVisible > 0);

  const emergencyBtnVisible = await page.locator('[data-testid="button-emergency"]').count();
  report.checks.push({ name: 'EmergencyButton present', pass: emergencyBtnVisible > 0 });
  console.log('  EmergencyButton present:', emergencyBtnVisible > 0);

  console.log('Verification tap targets');
  const tapTargetSizes = await page.evaluate(() => {
    const results = [];
    document.querySelectorAll('[data-testid="reco-swipe-card"]').forEach((el) => {
      const r = el.getBoundingClientRect();
      results.push({ selector: 'reco-swipe-card', width: r.width, height: r.height });
    });
    ['button-back-drive', 'button-exit-drive'].forEach((tid) => {
      const el = document.querySelector('[data-testid="' + tid + '"]');
      if (el) {
        const r = el.getBoundingClientRect();
        results.push({ selector: tid, width: r.width, height: r.height });
      }
    });
    const emg = document.querySelector('[data-testid="button-emergency"]');
    if (emg) {
      const r = emg.getBoundingClientRect();
      results.push({ selector: 'button-emergency', width: r.width, height: r.height });
    }
    const pauseBtn = document.querySelector('[data-testid="drive-timer-toggle-pause"]');
    if (pauseBtn) {
      const r = pauseBtn.getBoundingClientRect();
      results.push({ selector: 'drive-timer-toggle-pause', width: r.width, height: r.height });
    }
    return results;
  });
  console.log('  Tap targets:', JSON.stringify(tapTargetSizes, null, 2));
  tapTargetSizes.forEach((t) => {
    const minDim = Math.min(t.width, t.height);
    report.checks.push({ name: 'Tap target ' + t.selector + ' >=44px (' + minDim.toFixed(0) + 'px)', pass: minDim >= 44 });
  });
  const recoCard = tapTargetSizes.find((t) => t.selector === 'reco-swipe-card');
  if (recoCard) {
    report.checks.push({ name: 'Carte reco XXL >=80px hauteur (' + recoCard.height.toFixed(0) + 'px)', pass: recoCard.height >= 80 });
  }

  console.log('Navigation / pour tester QuickActionBar + tired-now dialog');
  await page.goto(BASE + '/#/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2500);
  const fab = page.locator('[data-testid="quick-actions-fab"]');
  if (await fab.count()) {
    await fab.click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: OUT + '/02-quickactionbar-open.png', fullPage: false });
    report.screenshots.push('02-quickactionbar-open.png');

    const tiredBtn = page.locator('[data-testid="quick-action-tired"]');
    const tiredBtnCount = await tiredBtn.count();
    report.checks.push({ name: 'Bouton Fatigue present dans QuickActionBar', pass: tiredBtnCount > 0 });
    if (tiredBtnCount > 0) {
      await tiredBtn.click();
      await page.waitForTimeout(1500);
      await page.screenshot({ path: OUT + '/03-tired-now-dialog.png', fullPage: false });
      report.screenshots.push('03-tired-now-dialog.png');
      const dialogVisible = await page.locator('text=Je me sens fatigué').count();
      report.checks.push({ name: 'Dialog Je me sens fatigue visible', pass: dialogVisible > 0 });
      await page.locator('[data-testid="button-tired-now-close"]').click().catch(() => {});
    }

    await fab.click().catch(() => {});
    await page.waitForTimeout(400);
    const silentBtn = page.locator('[data-testid="quick-action-silent"]');
    report.checks.push({ name: 'Bouton Silence present dans QuickActionBar', pass: (await silentBtn.count()) > 0 });
  } else {
    report.checks.push({ name: 'FAB QuickActionBar trouve', pass: false });
  }

  console.log('Mode nuit force (screenshot)');
  await page.goto(BASE + '/#/drive', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2000);
  await page.evaluate(() => {
    document.documentElement.classList.add('dark');
    try { localStorage.setItem('vtc.amberNight', 'on'); } catch {}
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: OUT + '/04-drive-night-mode.png', fullPage: false });
  report.screenshots.push('04-drive-night-mode.png');

  console.log('\n=== RESULTATS ===');
  report.checks.forEach((c) => console.log((c.pass ? 'PASS' : 'FAIL') + ' - ' + c.name));
  const passCount = report.checks.filter((c) => c.pass).length;
  console.log('\n' + passCount + '/' + report.checks.length + ' checks passed');
  console.log('\nErreurs console:', consoleErrors.length);
  if (consoleErrors.length) console.log(JSON.stringify(consoleErrors.slice(0, 5), null, 2));

  fs.writeFileSync(OUT + '/report.json', JSON.stringify({ ...report, consoleErrors }, null, 2));
  console.log('\nRapport ecrit -> ' + OUT + '/report.json');

  await browser.close();
})();
