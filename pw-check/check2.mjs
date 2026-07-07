import { chromium } from 'playwright';
const BASE = 'http://localhost:5555';
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);

const ls = await page.evaluate(() => ({...localStorage}));
console.log('LOCALSTORAGE:', JSON.stringify(ls, null, 2).slice(0, 2000));

await browser.close();
