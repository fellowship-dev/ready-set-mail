// "Before" walk on the live site: the owner's session, step by step, at 375x812 and 1440x900.
// Usage: node walk-before.mjs <base> <outdir>
import fs from "node:fs";
import { WIDTHS, measure, shot, newPage, mark, byText, textOf } from "./walk-lib.mjs";

const BASE = process.argv[2] || "https://readysetmail.com";
const OUT = process.argv[3] || "/tmp/walk-before";
const D = "readysetmail.com";
fs.mkdirSync(OUT, { recursive: true });
const log = [];
const rec = (o) => { log.push(o); console.log(JSON.stringify(o)); };
const settle = (p, ms = 2500) => p.waitForTimeout(ms);

for (const w of WIDTHS) {
  const { browser, page } = await newPage(w);
  const step = async (flow, n, name, primarySel, extra = {}) => {
    const m = await measure(page, primarySel);
    await shot(page, OUT, `${flow}-${n}-${name}-${w.name}`);
    rec({ width: w.name, flow, step: n, name, ...m, ...extra });
    return m;
  };
  const openMenuIfMobile = async () => {
    if (w.width < 768) {
      const b = page.locator("header button[aria-controls], header button[aria-label*='menu' i]").first();
      if (await b.count()) { await b.click(); await settle(page, 600); }
    }
  };

  // ---------- F-home: home check of readysetmail.com, then Back / reload ----------
  await page.goto("about:blank");
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  let sel = await mark(page, ["main form input[name=domain]"]);
  await step("home", 1, "landing", sel);
  await page.fill("main form input[name=domain]", D);
  const t0 = Date.now();
  await page.locator("main form button[type=submit]").first().click();
  await page.waitForSelector("text=/Level \\d/", { timeout: 20000 }).catch(() => {});
  await settle(page, 1500);
  // primary action of the result: the first filled (bg-brand) link/button after the result heading
  sel = await mark(page, ["main [data-next-step] a", "main a.bg-brand[href*='checker']", "main a[data-result-cta]", "main a.bg-brand"]);
  const result = await textOf(page, "#home-level", 2500);
  await step("home", 2, "result", sel, { ms: Date.now() - t0, resultText: result });
  // Every next-step link in the result and where it points
  const links = await page.evaluate(() => [...document.querySelectorAll("#home-level a")].map((a) => ({ text: a.textContent.trim().slice(0, 70), href: a.getAttribute("href") })));
  rec({ width: w.name, flow: "home", step: 2, name: "result-links", links });
  await page.reload({ waitUntil: "networkidle" });
  await settle(page, 1500);
  await step("home", 3, "after-reload", null, { resultStillShown: await page.locator("text=/Level \\d ·/").count() > 0 });
  // redo the check and press Back
  await page.fill("main form input[name=domain]", D);
  await page.locator("main form button[type=submit]").first().click();
  await page.waitForSelector("text=/Level \\d/", { timeout: 20000 }).catch(() => {});
  await page.goBack({ waitUntil: "load" }).catch(() => {});
  await settle(page, 800);
  rec({ width: w.name, flow: "home", step: 4, name: "back-after-check", url: page.url() });

  // ---------- F-header: header button, pressed repeatedly ----------
  await page.goto("about:blank");
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  for (let i = 1; i <= 3; i++) {
    await openMenuIfMobile();
    const hdr = await byText(page, /free domain check|check a domain/i);
    const href = hdr ? await page.locator(hdr).getAttribute("href") : null;
    if (!hdr) { rec({ width: w.name, flow: "header", step: i, name: "no-header-button" }); break; }
    await page.locator(hdr).click();
    await page.waitForLoadState("networkidle");
    await settle(page, 800);
    sel = await mark(page, ["main form input"]);
    await step("header", i, `after-click-${i}`, sel, { clickedHref: href });
  }
  // Check from the DMARC checker the header leads to
  await page.fill("main form input", D);
  const t1 = Date.now();
  await page.locator("main form button[type=submit]").first().click();
  await page.waitForURL(/\/r\/|domain=/, { timeout: 20000 }).catch(() => {});
  await settle(page, 3000);
  sel = await mark(page, ["main [data-next-step] a", "main button.bg-brand", "main a.bg-brand"]);
  await step("header", 4, "checker-result", sel, { ms: Date.now() - t1, resultText: await textOf(page, "main", 1800) });
  const reportUrl = page.url();
  const rlinks = await page.evaluate(() => [...document.querySelectorAll("main a, main button")].filter((e) => e.getBoundingClientRect().height > 0).map((a) => ({ text: a.textContent.trim().slice(0, 60), href: a.getAttribute("href") })).slice(0, 40));
  rec({ width: w.name, flow: "header", step: 4, name: "checker-result-links", links: rlinks });
  await page.goBack({ waitUntil: "load" }).catch(() => {});
  await settle(page, 1500);
  rec({ width: w.name, flow: "header", step: 5, name: "back-from-result", url: page.url() });
  await page.goBack({ waitUntil: "load" }).catch(() => {});
  await settle(page, 800);
  rec({ width: w.name, flow: "header", step: 6, name: "back-again", url: page.url() });

  // ---------- F-tool: bare checker link with ?domain= (the owner's last screen) ----------
  await page.goto(`${BASE}/tools/dmarc-checker?domain=${D}`, { waitUntil: "networkidle" });
  await settle(page, 3500);
  sel = await mark(page, ["main [data-next-step] a", "main a.bg-brand", "main button.bg-brand"]);
  await step("tool", 1, "bare-dmarc-link", sel, { resultText: await textOf(page, "main", 1500) });
  const person = await page.evaluate(() => {
    const p = [...document.querySelectorAll("main p")].find((e) => /Want a person/.test(e.textContent));
    const box = p?.parentElement;
    return box ? { heading: p.textContent.trim(), actions: [...box.querySelectorAll("a")].map((a) => ({ text: a.textContent.trim(), href: a.getAttribute("href") })) } : null;
  });
  rec({ width: w.name, flow: "tool", step: 1, name: "want-a-person-cta", person, currentPath: new URL(page.url()).pathname });
  const loopLinks = await page.evaluate(() => [...document.querySelectorAll("main a")].filter((a) => /checker/.test(a.getAttribute("href") || "")).map((a) => ({ text: a.textContent.trim().slice(0, 50), href: a.getAttribute("href") })));
  rec({ width: w.name, flow: "tool", step: 1, name: "checker-links-on-page", n: loopLinks.length, loopLinks: loopLinks.slice(0, 15) });

  // ---------- F-agencies: the check the owner liked ----------
  await page.goto("about:blank");
  await page.goto(`${BASE}/for-agencies`, { waitUntil: "networkidle" });
  sel = await mark(page, ["main form input"]);
  await step("agencies", 1, "landing", sel);
  await page.fill("main form input", D);
  await page.locator("main form button[type=submit]").first().click();
  await page.waitForURL(/\/r\//, { timeout: 20000 }).catch(() => {});
  await settle(page, 3000);
  sel = await mark(page, ["main [data-next-step] a", "main button.bg-brand", "main a.bg-brand"]);
  await step("agencies", 2, "result", sel, { resultText: await textOf(page, "main", 1200) });
  await page.reload({ waitUntil: "networkidle" });
  rec({ width: w.name, flow: "agencies", step: 3, name: "reload", url: page.url() });
  await page.goBack({ waitUntil: "load" }).catch(() => {});
  await settle(page, 1500);
  rec({ width: w.name, flow: "agencies", step: 4, name: "back", url: page.url(), inputValue: await page.locator("main form input").first().inputValue().catch(() => null) });

  // ---------- F-report cold: open the report link fresh ----------
  if (/\/r\//.test(reportUrl)) {
    const { browser: b2, page: p2 } = await newPage(w);
    await p2.goto(reportUrl, { waitUntil: "networkidle" });
    const s2 = await mark(p2, ["main [data-next-step] a", "main button.bg-brand", "main a.bg-brand"]);
    const m = await measure(p2, s2);
    await shot(p2, OUT, `report-1-cold-${w.name}`);
    await p2.screenshot({ path: `${OUT}/report-1-cold-${w.name}-full.png`, fullPage: true });
    rec({ width: w.name, flow: "report", step: 1, name: "cold", ...m, url: "/r/:id" });
    await b2.close();
  }

  // ---------- Error page ----------
  await page.goto(`${BASE}/errors/550-5-7-26`, { waitUntil: "networkidle" });
  sel = await mark(page, ["main form button[type=submit]"]);
  await step("error", 1, "landing", sel);

  // ---------- Menu ----------
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await openMenuIfMobile();
  const menu = await page.evaluate(() => [...document.querySelectorAll("header a, [role=dialog] a, nav a")].filter((a) => a.getBoundingClientRect().height > 0).map((a) => a.textContent.trim()).filter(Boolean).slice(0, 20));
  await shot(page, OUT, `menu-${w.name}`);
  rec({ width: w.name, flow: "menu", menu });
  await browser.close();
}
fs.writeFileSync(`${OUT}/walk.json`, JSON.stringify(log, null, 1));
