// Usage: node step.mjs <name> <actionFile|-> [both|wide|mirror]
// Connects to the long-lived Chromium on :9222. Page 0 is 1440 wide, page 1 is 375 wide; they share cookies.
// The action file is an async function body with (wide, narrow, h) in scope; it acts on `wide` (and optionally `narrow`).
// After the action: screenshot wide; mode "mirror" (default) loads wide's URL into narrow and screenshots it;
// mode "both" means the action already drove narrow too; mode "wide" skips narrow.
import { chromium } from '@playwright/test';
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
const [name, actionFile, mode = 'mirror'] = process.argv.slice(2);
const OUT = '/tmp/shots';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
let pages = ctx.pages();
while (pages.length < 2) { await ctx.newPage(); pages = ctx.pages(); }
const [wide, narrow] = pages;
await wide.setViewportSize({ width: 1440, height: 900 });
await narrow.setViewportSize({ width: 375, height: 812 });
const errs = { wide: [], narrow: [] };
for (const [k, p] of [['wide', wide], ['narrow', narrow]]) {
  p.on('console', (m) => { if (['error', 'warning'].includes(m.type())) errs[k].push(`console.${m.type()}: ${m.text().slice(0, 200)}`); });
  p.on('pageerror', (e) => errs[k].push(`pageerror: ${e.message.slice(0, 200)}`));
  p.on('response', (r) => { if (r.status() >= 400) errs[k].push(`http ${r.status()} ${r.request().method()} ${r.url().replace(/^https?:\/\/[^/]+/, '').slice(0, 120)}`); });
}
const h = {
  mail: () => {
    // Newest captured message from wrangler's local send_email (logged path to an .eml file).
    const logTxt = readFileSync('/tmp/wrangler-saas.log', 'utf8');
    const paths = [...logTxt.matchAll(/(\/[^\s"']+\.eml)/g)].map((m) => m[1]);
    return paths.length ? readFileSync(paths[paths.length - 1], 'utf8') : null;
  },
  settle: async (p, ms = 1200) => { await p.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {}); await p.waitForTimeout(ms); },
};
const t0 = Date.now();
let actionErr = null;
let result = null;
if (actionFile && actionFile !== '-') {
  const body = readFileSync(actionFile, 'utf8');
  const fn = new Function('wide', 'narrow', 'h', `return (async () => { ${body} })();`);
  try { result = await fn(wide, narrow, h); } catch (e) { actionErr = e.message.split('\n')[0].slice(0, 300); }
}
const ms = Date.now() - t0;
await h.settle(wide, 600);
async function cap(p, w) {
  await p.bringToFront().catch(() => {}); await p.waitForTimeout(300);
  await p.screenshot({ path: `${OUT}/${name}-${w}.png`, timeout: 15000 }).catch((e) => errs.wide.push('shot: ' + e.message.slice(0, 80)));
  await p.screenshot({ path: `${OUT}/${name}-${w}-full.png`, fullPage: true }).catch(() => {});
  return p.evaluate(() => ({
    title: document.title, url: location.href.replace(/^https?:\/\/[^/]+/, ''),
    overflowX: document.documentElement.scrollWidth - window.innerWidth,
    text: document.body.innerText.replace(/\n{2,}/g, '\n').slice(0, 5000),
    controls: [...document.querySelectorAll('a,button,input,select,textarea')].filter((a) => a.offsetParent !== null)
      .map((a) => `${a.tagName.toLowerCase()}|${(a.innerText || a.getAttribute('aria-label') || a.getAttribute('placeholder') || a.name || '').trim().replace(/\s+/g, ' ').slice(0, 50)}|${a.getAttribute('href') || a.type || ''}`).slice(0, 80),
  })).catch((e) => ({ err: e.message }));
}
const out = { name, ms, actionErr, result };
out.wide = await cap(wide, '1440');
if (mode === 'mirror') {
  await narrow.goto(wide.url()).catch(() => {});
  await h.settle(narrow, 800);
}
if (mode !== 'wide') out.narrow = await cap(narrow, '375');
out.errs = errs;
appendFileSync(`${OUT}/walk-b.jsonl`, JSON.stringify(out) + '\n');
// Print a compact view
console.log(JSON.stringify({ name, ms, actionErr, result, url: (out.wide.url || '').replace(/(welcome\/|reset\/|invite\/)[^/?#]{12,}/, '$1<token>'), overflow375: out.narrow?.overflowX, errs }, null, 0));
console.log('--- 1440 text ---\n' + (out.wide.text || '').slice(0, 2500));
console.log('--- controls ---\n' + (out.wide.controls || []).join('\n'));
// no browser.close(): over CDP it could close the shared browser
process.exit(0);
