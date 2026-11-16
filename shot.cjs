const { chromium } = require("@playwright/test");
(async () => {
  const [url, prefix] = process.argv.slice(2);
  const b = await chromium.launch();
  for (const w of [375, 1440]) {
    const p = await b.newPage({ viewport: { width: w, height: 900 } });
    await p.goto(url, { waitUntil: "networkidle" });
    await p.waitForTimeout(800);
    await p.screenshot({ path: `${prefix}-${w}.png`, fullPage: true });
    console.log(w, (await p.evaluate(() => document.body.innerText)).includes("Proposed, not yet applied"));
  }
  await b.close();
})();
