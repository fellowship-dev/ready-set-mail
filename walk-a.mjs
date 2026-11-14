// Live, read-only walk of the website and the hosted app's public pages. No form is submitted.
import { chromium } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
const OUT = '/tmp/shots';
mkdirSync(OUT, { recursive: true });
const SITE = 'https://inbox-angel-fellowship-dev.vercel.app';
const APP = 'https://app.readysetmail.com';
const log = [];
const browser = await chromium.launch();
const W = { '1440': { width: 1440, height: 900 }, '375': { width: 375, height: 812 } };

async function ctxFor(w) {
  const ctx = await browser.newContext({ viewport: W[w], deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page._errs = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') page._errs.push(`console.${m.type()}: ${m.text().slice(0, 200)}`); });
  page.on('pageerror', (e) => page._errs.push(`pageerror: ${e.message.slice(0, 200)}`));
  page.on('requestfailed', (r) => page._errs.push(`failed: ${r.url().slice(0, 150)} ${r.failure()?.errorText}`));
  page.on('response', (r) => { if (r.status() >= 400) page._errs.push(`http ${r.status()}: ${r.url().slice(0, 150)}`); });
  return { ctx, page };
}
async function record(page, name, w, t, extra = {}) {
  const path = `${OUT}/${name}-${w}.png`;
  await page.screenshot({ path, fullPage: w === '375' ? false : false }).catch(() => {});
  await page.screenshot({ path: `${OUT}/${name}-${w}-full.png`, fullPage: true }).catch(() => {});
  const info = await page.evaluate(() => ({
    title: document.title,
    url: location.href,
    overflowX: document.documentElement.scrollWidth - window.innerWidth,
    text: (document.querySelector('main') || document.body).innerText.replace(/\n{2,}/g, '\n').slice(0, 6000),
    links: [...document.querySelectorAll('a,button')].filter((a) => a.offsetParent !== null).map((a) => `${a.tagName === 'A' ? 'a' : 'btn'}|${(a.innerText || a.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 60)}|${a.getAttribute('href') || ''}`).slice(0, 120),
  })).catch((e) => ({ err: e.message }));
  log.push({ name, w, ms: t, errs: [...page._errs], ...info, ...extra });
  page._errs.length = 0;
}
async function visit(name, url, widths = ['1440', '375']) {
  for (const w of widths) {
    const { ctx, page } = await ctxFor(w);
    const t0 = Date.now();
    try { await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }); } catch (e) { page._errs.push('goto: ' + e.message.slice(0, 120)); }
    await page.waitForTimeout(800);
    await record(page, name, w, Date.now() - t0);
    await ctx.close();
  }
}
async function check(name, path, domain, widths = ['1440', '375']) {
  for (const w of widths) {
    const { ctx, page } = await ctxFor(w);
    await page.goto(SITE + path, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    const input = page.locator('input[type=text],input[type=search],input[name=domain],input[inputmode=url],input[type=url]').first();
    await input.fill(domain);
    const t0 = Date.now();
    await input.press('Enter');
    let ms = null;
    try { await page.waitForFunction(() => /Level [0-2]|could not|does not look|not exist|Policy|record/i.test((document.querySelector('[aria-live]') || document.body).innerText) && !/Checking/i.test(document.body.innerText.slice(0, 3000)), null, { timeout: 15000 }); ms = Date.now() - t0; } catch {}
    await page.waitForTimeout(1500);
    await record(page, name, w, ms, { domain });
    await ctx.close();
  }
}

// Flow 1: home, checks
await visit('a1-home', SITE + '/');
for (const [k, d] of [['nodmarc', 'neverssl.com'], ['pnone', 'iana.org'], ['preject', 'google.com'], ['subdomain', 'docs.github.com'], ['invalid', 'not a domain'], ['nxdomain', 'no-such-domain-rsm-walk-2026.com'], ['wwwpaste', 'https://www.google.com/mail']]) {
  await check(`a2-check-${k}`, '/', d);
}
// Flow 2/3: pricing, booking
await visit('b1-pricing', SITE + '/pricing');
await visit('b2-booking-tidycal', 'https://tidycal.com/maxfindel');
// Flow 4: landing pages
await visit('d1-for-agencies', SITE + '/for-agencies');
await check('d2-for-agencies-check', '/for-agencies', 'iana.org');
await visit('d3-bounce-5-7-26', SITE + '/bounce/5-7-26');
await visit('d4-dmarc-checker-deeplink', SITE + '/tools/dmarc-checker?domain=neverssl.com');
await visit('d5-tools', SITE + '/tools');
// Flow 10: legal
for (const p of ['terms', 'privacy', 'refund-policy', 'security']) await visit(`l-${p}`, `${SITE}/${p}`, ['1440', '375']);
// App public pages (nothing submitted)
await visit('p1-app-root', APP + '/');
await visit('p2-app-signup', APP + '/#/signup');
await visit('p3-app-signup-domain', APP + '/#/signup?domain=iana.org');
await visit('p4-app-welcome-x', APP + '/#/welcome/x');
await visit('p5-app-forgot', APP + '/#/forgot');
await visit('p6-app-reset-x', APP + '/#/reset/x');
writeFileSync(`${OUT}/walk-a.json`, JSON.stringify(log, null, 1));
await browser.close();
console.log('WALK_A_DONE', log.length);
