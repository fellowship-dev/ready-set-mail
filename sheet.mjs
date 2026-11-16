// node sheet.mjs <out.png> <title> <dir>:<stepFilter?> ... — one row of 375 light screenshots per path, in order, with step labels.
import { chromium } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
const OUT = `${process.env.HOME}/walk-out`;
const [out, title, ...specs] = process.argv.slice(2);
const rows = [];
for (const spec of specs) {
  const [label, ...dirs] = spec.split('='); // label=dir1,dir2
  const items = [];
  for (const d of dirs.join('=').split(',')) {
    const raw = path.join(OUT, d, 'raw.json');
    if (!existsSync(raw)) continue;
    const r = JSON.parse(readFileSync(raw, 'utf8'));
    for (const s of r.steps) {
      const f = s.screenshots['375-light'];
      if (!f) continue;
      const m = s.measures?.[375] || {};
      const words = m.words ?? '';
      items.push({ src: 'data:image/png;base64,' + readFileSync(path.join(OUT, d, f)).toString('base64'), cap: `${s.index}. ${s.step}`, sub: `${words} words · ${s.clicks ?? 0} clicks · ${s.keystrokes ?? 0} keys` });
    }
  }
  rows.push({ label, items });
}
const html = `<!doctype html><html><body style="margin:0;background:#fff;font:14px system-ui;color:#111"><h1 style="font-size:20px;margin:16px">${title}</h1>${rows.map((r) => `<section style="margin:8px 16px 24px"><h2 style="font-size:16px;margin:4px 0 8px">${r.label}</h2><div style="display:flex;gap:10px;align-items:flex-start">${r.items.map((i) => `<figure style="margin:0;width:250px"><img src="${i.src}" style="width:250px;border:1px solid #ccc"><figcaption style="font-size:12px;margin-top:4px"><b>${i.cap}</b><br>${i.sub}</figcaption></figure>`).join('')}</div></section>`).join('')}</body></html>`;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 400 + Math.max(...rows.map((r) => r.items.length)) * 260, height: 600 } });
await p.setContent(html, { waitUntil: 'load' });
await p.screenshot({ path: out, fullPage: true });
await b.close();
console.log('sheet', out);
