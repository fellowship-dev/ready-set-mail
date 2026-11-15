import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { iconSvg, LOGO_COLORS, lockupSvg } from "../src/components/logo-svg";
import { darkColors, lightColors } from "../src/tokens/tokens";

// A path, not `new URL(template, import.meta.url)`: Vite rewrites that pattern as an asset import.
const brandDir = join(dirname(fileURLToPath(import.meta.url)), "../../../web/public/brand");
const brand = (rel: string) => readFileSync(join(brandDir, rel), "utf8");

/** The logo data the components draw is the asset pack, exactly: rebuilding the three SVG files from it gives the same bytes. */
describe("logo data matches the brand asset pack", () => {
	it("icon.svg", () => expect(`${iconSvg()}\n`).toBe(brand("svg/icon.svg")));
	it("lockup.svg (navy wordmark, light surfaces)", () => expect(`${lockupSvg("light")}\n`).toBe(brand("svg/lockup.svg")));
	it("lockup-dark.svg (white wordmark, dark surfaces)", () => expect(`${lockupSvg("dark")}\n`).toBe(brand("svg/lockup-dark.svg")));
	it("the favicon SVG is the icon", () => expect(brand("favicon/favicon.svg")).toBe(brand("svg/icon.svg")));
	it("the lockup wordmark token is the pack's navy and white", () => {
		expect(lightColors["logo-wordmark"]).toBe(LOGO_COLORS.navy.toLowerCase());
		expect(darkColors["logo-wordmark"]).toBe(LOGO_COLORS.white.toLowerCase());
		expect(lightColors.brand).toBe(LOGO_COLORS.blue.toLowerCase());
		expect(lightColors["ink-1"]).toBe(LOGO_COLORS.navy.toLowerCase());
	});
});

/**
 * Brand rules that a later change could quietly break (DESIGN.md, "Logo and brand colours"): the logo's red #FF252B is used
 * only inside the logo, and the retired gold/blush brand colours do not come back. Scans everything the product ships.
 */
describe("brand colours stay where they belong", () => {
	const roots = ["../src/", "../gallery/src/", "../../../web/src/", "../../../web/index.html", "../../../src/", "../../report/src/"];
	const exts = /\.(css|ts|tsx|js|jsx|mjs|html|svg)$/;
	const files: string[] = [];
	const walk = (dir: URL) => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			if (e.isDirectory()) walk(new URL(`${e.name}/`, dir));
			else if (exts.test(e.name)) files.push(fileURLToPath(new URL(e.name, dir)));
		}
	};
	for (const r of roots) {
		if (r.endsWith("/")) walk(new URL(r, import.meta.url));
		else files.push(fileURLToPath(new URL(r, import.meta.url)));
	}
	const hits = (re: RegExp, allowed: (f: string) => boolean) =>
		files.filter((f) => !allowed(f)).flatMap((f) =>
			readFileSync(f, "utf8").split("\n").flatMap((line, i) => (re.test(line) ? [`${f}:${i + 1}`] : [])),
		);

	it("scans the UI package, the dashboard, the Worker and the report", () => {
		expect(files.some((f) => f.endsWith("/components/logo-svg.ts"))).toBe(true);
		expect(files.some((f) => f.endsWith("/src/mcp/consent.ts"))).toBe(true);
		expect(files.some((f) => f.endsWith("/report/src/render-html.ts"))).toBe(true);
	});
	it("the logo red appears only in the logo data", () => {
		const logoFiles = (f: string) => f.endsWith("/components/logo-svg.ts");
		expect(hits(/#ff252b\b/i, logoFiles)).toEqual([]);
	});
	it("no retired gold or blush brand colour", () => {
		// halo gold, its hover and tint, the dark gold tint, blush
		expect(hits(/#(?:fad172|f5c04a|fef7e3|ffe09a|332c1d|2a2210|fca0a4)\b/i, () => false)).toEqual([]);
	});
	it("a filled brand surface is an action or a selection, never a state (DESIGN.md, The Action-Fill Rule)", () => {
		// Unprefixed bg-brand / bg-brand-ink (state variants such as data-[state=checked]: are controls and allowed).
		const fill = /(?<![\w:-])bg-brand(?:-ink)?(?![\w-])/;
		const allowed = (f: string) =>
			/\/components\/(?:button-variants\.ts|app-shell\.tsx)$/.test(f) || // primary button, skip link
			/\/wizard\/WizardProgress\.tsx$/.test(f) || /\/screens\/SetupWizardStep\.tsx$/.test(f); // wizard progress toward an action
		expect(hits(fill, allowed)).toEqual([]);
	});
	it("no accent or blush utility: they are not tokens any more", () => {
		expect(hits(/\b(?:bg|text|border|ring|fill|stroke|outline)-(?:accent|blush)\b|var\(--(?:accent|blush)/, () => false)).toEqual([]);
	});
});
