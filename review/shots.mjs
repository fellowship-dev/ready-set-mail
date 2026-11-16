import { chromium } from 'playwright';
import { readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const REV = join(homedir(), 'rev'), E = join(REV, 'emails'), S = join(REV, 'shots');
const files = readdirSync(E).filter((f) => f.endsWith('.html')).sort();
const browser = await chromium.launch();
const widths = {};
for (const scheme of ['light', 'dark']) {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 800 }, colorScheme: scheme });
  const page = await ctx.newPage();
  await page.emulateMedia({ colorScheme: scheme });
  for (const f of files) {
    const name = f.replace(/\.html$/, '');
    await page.goto('file://' + join(E, f));
    const sw = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, h: document.documentElement.scrollHeight }));
    widths[`${name}${scheme === 'dark' ? '.dark' : ''}`] = sw;
    await page.screenshot({ path: join(S, `${name}${scheme === 'dark' ? '.dark' : ''}.png`), fullPage: true });
  }
  await ctx.close();
}
writeFileSync(join(REV, 'scrollwidths.json'), JSON.stringify(widths, null, 1));
// contact sheet
const cells = files.map((f) => { const n = f.replace(/\.html$/, ''); return `<figure><img src="file://${join(S, n + '.png')}"><figcaption>${n}</figcaption></figure>`; }).join('');
writeFileSync(join(REV, 'contact.html'), `<!doctype html><meta charset=utf-8><style>body{margin:12px;font:12px Arial;background:#ddd}main{display:grid;grid-template-columns:repeat(6,200px);gap:10px;align-items:start}figure{margin:0;background:#fff;padding:4px}img{width:192px;display:block;border:1px solid #999}figcaption{word-break:break-all;margin-top:4px}</style><main>${cells}</main>`);
const ctx = await browser.newContext({ viewport: { width: 1320, height: 900 } });
const page = await ctx.newPage();
await page.goto('file://' + join(REV, 'contact.html'));
await page.waitForLoadState('load');
await page.screenshot({ path: join(S, 'contact-sheet.png'), fullPage: true });
await browser.close();
console.log(files.length, 'files');
