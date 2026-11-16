// Shared measuring helpers for the check-flow walks (before and after). Runs inside a devbox with Playwright.
import { chromium } from "@playwright/test";

export const WIDTHS = [
  { name: "375", width: 375, height: 812 },
  { name: "1440", width: 1440, height: 900 },
];

/** Measures of the current screen relative to a primary element (selector string or null). */
export async function measure(page, primarySel) {
  return page.evaluate((sel) => {
    const vh = window.innerHeight;
    const main = document.querySelector("main") || document.body;
    const prim = sel ? document.querySelector(sel) : null;
    const pr = prim ? prim.getBoundingClientRect() : null;
    const primTop = pr ? pr.top + window.scrollY : null;
    const primBottom = pr ? pr.bottom + window.scrollY : null;
    // words above the primary action: text nodes in main whose top is above the primary's top
    let wordsAbove = 0, words = 0;
    const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const el = n.parentElement;
      if (!el) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || el.closest(".sr-only,[aria-hidden=true],script,style")) continue;
      const t = n.textContent.trim();
      if (!t) continue;
      const w = t.split(/\s+/).length;
      words += w;
      const r = document.createRange(); r.selectNodeContents(n);
      const rr = r.getBoundingClientRect();
      if (rr.width === 0 && rr.height === 0) continue;
      if (primTop !== null && rr.top + window.scrollY < primTop) wordsAbove += w;
    }
    const inMain = (q) => [...main.querySelectorAll(q)].filter((e) => e.getBoundingClientRect().height > 0).length;
    return {
      url: location.pathname + location.search + location.hash,
      historyLength: history.length,
      title: document.title,
      primary: prim ? (prim.textContent || "").trim().slice(0, 80) : null,
      primaryHref: prim ? prim.getAttribute("href") : null,
      // viewport heights scrolled before the primary is fully visible (0 = in the first screen)
      scrollBeforePrimaryVh: primBottom === null ? null : Math.max(0, +((primBottom - vh) / vh).toFixed(2)),
      primaryY: primTop === null ? null : +(primTop / vh).toFixed(2),
      words,
      wordsAbove,
      badges: inMain("[data-status]"),
      buttons: inMain("button, a[class*='rounded'][class*='font-semibold']"),
      links: inMain("a[href]"),
      pageHeightVh: +(document.documentElement.scrollHeight / vh).toFixed(1),
      overflowX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
    };
  }, primarySel);
}

export async function shot(page, dir, name) {
  await page.screenshot({ path: `${dir}/${name}.png`, fullPage: false });
}

export async function newPage(w) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: w.width, height: w.height }, deviceScaleFactor: 1, isMobile: w.width < 500, hasTouch: w.width < 500 });
  const page = await ctx.newPage();
  return { browser, page };
}

/** The first visible element matching any selector, as a unique selector we can measure (adds a data attribute). */
export async function mark(page, selectors, tag = "data-walk-primary") {
  return page.evaluate(([sels, tag]) => {
    document.querySelectorAll(`[${tag}]`).forEach((e) => e.removeAttribute(tag));
    for (const s of sels) {
      for (const e of document.querySelectorAll(s)) {
        const r = e.getBoundingClientRect();
        if (r.height > 0 && r.width > 0) { e.setAttribute(tag, "1"); return `[${tag}]`; }
      }
    }
    return null;
  }, [selectors, tag]);
}

export async function byText(page, re, tag = "data-walk-primary") {
  return page.evaluate(([src, flags, tag]) => {
    const rx = new RegExp(src, flags);
    document.querySelectorAll(`[${tag}]`).forEach((e) => e.removeAttribute(tag));
    for (const e of document.querySelectorAll("main a, main button, header a, header button")) {
      const r = e.getBoundingClientRect();
      if (r.height > 0 && rx.test((e.textContent || "").trim())) { e.setAttribute(tag, "1"); return `[${tag}]`; }
    }
    return null;
  }, [re.source, re.flags, tag]);
}

/** Visible text of the result region (first match), trimmed. */
export async function textOf(page, sel, max = 1500) {
  return page.evaluate(([s, m]) => { const e = document.querySelector(s); return e ? e.innerText.replace(/\n{2,}/g, "\n").slice(0, m) : null; }, [sel, max]);
}
