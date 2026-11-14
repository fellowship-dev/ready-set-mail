import { expect, test } from "@playwright/test";
import { signIn } from "../e2e/support/session";
import { ensureDomain, runSql } from "../e2e/support/db";
test.use({ trace: "off", screenshot: "off", video: "off" });
test("domain page, overview and DMARC wizard at 375 and 1440", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await signIn(page);
  runSql("INSERT OR IGNORE INTO settings (workspace_id, key, value) VALUES ('ws_default', 'reports_domain', 'reports.e2e.example.com');");
  await ensureDomain(page, "example.net");
  const list = await (await page.request.get("/api/domains")).json() as { domains: Array<{ id: number; domain: string }> };
  expect(list.domains.length).toBeGreaterThan(0);
  const id = list.domains[0]!.id;
  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [path, heading] of [["/#/", "Domains"], [`/#/domains/${id}`, list.domains[0]!.domain], [`/#/domains/${id}/dmarc-wizard`, null]] as const) {
      await page.goto(path);
      if (heading) await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
      await page.waitForLoadState("networkidle");
      if (path.endsWith(String(id))) { for (const name of [/^DNS records/, /^Reports/]) { const b = page.getByRole("button", { name }); if (await b.count()) await b.first().click(); } await page.waitForLoadState("networkidle"); }
      const m = await page.evaluate(() => {
        const doc = document.documentElement;
        const clipped = [...document.querySelectorAll("main *")].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.right > window.innerWidth + 1; }).slice(0, 5).map((el) => el.tagName + "." + (el.className?.toString?.() ?? "").slice(0, 60));
        return { sw: doc.scrollWidth, iw: window.innerWidth, clipped, h2: [...document.querySelectorAll("h1,h2")].map((h) => h.textContent?.trim()).slice(0, 12), text: document.body.innerText.slice(0, 1500) };
      });
      console.log(JSON.stringify({ width, path, ...m, text: undefined }));
      console.log("TEXT", width, path, m.text.replace(/\s+/g, " ").slice(0, 900));
      expect(m.sw, `${path} at ${width}: horizontal scroll`).toBeLessThanOrEqual(m.iw);
      expect(m.clipped, `${path} at ${width}: elements past the right edge`).toEqual([]);
    }
  }
  expect(errors.filter((e) => !/Failed to load resource|favicon/.test(e))).toEqual([]);
});
