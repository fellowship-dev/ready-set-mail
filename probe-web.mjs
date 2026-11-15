import { chromium } from '@playwright/test';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const dump = async (label) => {
  const d = await p.evaluate(() => {
    const vis = (e) => e.checkVisibility ? e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : true;
    return {
      url: location.href.replace(/\/r\/[^/?#]+/, '/r/<id>'),
      h: [...document.querySelectorAll('h1,h2,h3')].filter(vis).map((e) => e.tagName + ':' + e.innerText.trim().slice(0, 70)).slice(0, 25),
      inputs: [...document.querySelectorAll('input,textarea,select')].filter(vis).map((e) => `${e.tagName}#${e.id}[name=${e.name}][type=${e.type}] form=${e.form?.getAttribute('action')}`),
      buttons: [...document.querySelectorAll('button,[role=button]')].filter(vis).map((e) => `${(e.innerText || e.getAttribute('aria-label') || '').trim().slice(0, 40)} type=${e.type}`).slice(0, 20),
      links: [...document.querySelectorAll('main a[href]')].filter(vis).map((e) => `${e.innerText.trim().slice(0, 40)} -> ${e.getAttribute('href').replace(/\/r\/[^/?#]+/, '/r/<id>')}`).slice(0, 40),
    };
  });
  console.log('=== ' + label, JSON.stringify(d, null, 1));
};
for (const path of ['/', '/tools/dmarc-checker', '/errors/550-5-7-26', '/for-agencies']) {
  await p.goto('https://readysetmail.com' + path, { waitUntil: 'networkidle' });
  await dump(path + ' before');
  const inp = p.locator('input[name=domain], input[inputmode=url], input[type=text]').first();
  if (!(await inp.count())) { console.log('no input'); continue; }
  await inp.fill('github.com');
  const t0 = Date.now();
  await inp.press('Enter');
  await p.waitForTimeout(1000);
  for (let i = 0; i < 40; i++) { await p.waitForTimeout(500); const busy = await p.evaluate(() => /Checking|Looking up|Loading/i.test(document.body.innerText)); if (!busy) break; }
  await p.waitForLoadState('networkidle').catch(() => {});
  console.log('elapsed', Date.now() - t0);
  await dump(path + ' after');
}
await b.close();
