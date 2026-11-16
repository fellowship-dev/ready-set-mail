import { test } from "@playwright/test";
import { INTAKE, ownerWithZones, save, startInstance, fakeCf } from "./rev-lib";
test.setTimeout(400_000);
test("H3", async ({ page }) => {
 const inst = await startInstance({ mode: "hosted", port: 8891, tokenKey: true, vars: { INTAKE_DOMAIN: INTAKE, HOSTED_CONNECT_REPORTS: "all" } });
 try {
  const { ids } = await ownerWithZones(page, inst, "owner@harbor-lane.org", ["h3-linked.net"], { "h3-linked.net": ["v=DMARC1; p=reject;"] });
  const id = ids["h3-linked.net"]; const out: any[] = [];
  await page.setViewportSize({ width: 375, height: 812 });
  for (const p of ["spf-flatten", "mta-sts"]) {
   await page.goto(`${inst.url}/#/domains/${id}/${p}`); await page.reload(); await page.waitForTimeout(5000);
   await page.screenshot({ path: `/tmp/walk/shots/600-H3-${p}-375-full.png`, fullPage: true });
   const text = await page.locator("main").innerText(); const btns = await page.locator("main button").evaluateAll(bs => bs.map(b => `${(b as HTMLButtonElement).innerText}${(b as HTMLButtonElement).disabled ? " [disabled]" : ""}`));
   const links = await page.locator("main a").allInnerTexts();
   out.push({ p, text, btns, links });
  }
  out.push({ fake: Object.values((await fakeCf(inst, "GET", "/__state")).records).flat().map((x: any) => `${x.type} ${x.name} ${x.content}`) });
  save("H3", out);
 } finally { await inst.stop(); }
});
