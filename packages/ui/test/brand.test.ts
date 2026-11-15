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
// bg-brand, bg-brand-ink, -hover and -active, with or without a variant prefix (hover:, data-[state=open]:, md:, ...).
const FILL = /(?<![\w-])bg-brand(?:-ink|-hover|-active)?(?![\w-])/;
// The same fills written as CSS: background / background-color / backgroundColor set to var(--brand), --brand-ink, ...
const INLINE_FILL = /background(?:-?[cC]olor)?["']?\s*:\s*["'`]?var\(--(?:color-)?brand(?:-ink|-hover|-active)?\)/;

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
		// Each exception names the one use it allows, as a pattern removed from its file before the scan, so a second,
		// forbidden fill in the same file or on the same line still fails.
		const exceptions: [RegExp, RegExp][] = [
			[/\/components\/button-variants\.ts$/, /primary: "bg-brand text-brand-fg hover:bg-brand-hover active:bg-brand-active"/g], // primary button
			[/\/components\/app-shell\.tsx$/, /rounded-md bg-brand px-4 py-2/g], // skip link
			[/\/components\/app-shell\.tsx$/, /before:bg-brand-ink/g], // the marker on the selected navigation item (aria-current)
			[/\/components\/(?:checkbox|switch|radio-group|segmented[\w-]*)\.tsx$/, /data-\[state=(?:checked|indeterminate)\]:bg-brand(?![\w-])/g], // checked controls
			[/\/(?:wizard\/WizardProgress|screens\/SetupWizardStep)\.tsx$/, /(?:isCurrent|state === "current") \? ["']bg-brand["']/g], // wizard progress, current step (the gallery mock mirrors it)
			[/\/styles\/theme\.css$/, /border-line, bg-brand,/g], // a comment naming the utilities
			[/\/styles\/base\.css$/, /::selection\s*\{[^}]*\}/g], // the text-selection highlight
			[/\/src\/mcp\/consent\.ts$/, /\.primary(?::hover)?\{background:var\(--brand(?:-hover)?\)/g], // the consent page's primary button
		];
		const strip = (f: string, text: string) =>
			exceptions.reduce((t, [file, re]) => (file.test(f) ? t.replace(re, (m) => m.replace(/[^\n]/g, " ")) : t), text);
		const found = files.flatMap((f) =>
			strip(f, readFileSync(f, "utf8")).split("\n").flatMap((line, i) => (FILL.test(line) || INLINE_FILL.test(line) ? [`${f}:${i + 1}`] : [])),
		);
		expect(found).toEqual([]);
	});
	it("the fill patterns catch what they should and nothing else", () => {
		for (const bad of ["hover:bg-brand", "group-hover:bg-brand-ink", "data-[x]:bg-brand-ink", "md:bg-brand", "bg-brand-hover", "active:bg-brand-active", "bg-brand", "bg-brand/90"]) {
			expect(FILL.test(bad), bad).toBe(true);
		}
		for (const bad of ["background-color: var(--brand)", "background:var(--brand-hover)", "background: var(--color-brand)", "backgroundColor: 'var(--brand)'"]) {
			expect(INLINE_FILL.test(bad), bad).toBe(true);
		}
		for (const ok of ["bg-brand-subtle", "hover:bg-brand-subtle", "bg-brand-fg", "text-brand-ink", "border-brand", "ring-brand", "hover:text-brand-ink"]) {
			expect(FILL.test(ok), ok).toBe(false);
		}
		for (const ok of ["background: var(--brand-subtle)", "background:var(--brand-fg)", "color: var(--brand)", "border-color:var(--brand)"]) {
			expect(INLINE_FILL.test(ok), ok).toBe(false);
		}
	});
	it("no accent or blush utility: they are not tokens any more", () => {
		expect(hits(/\b(?:bg|text|border|ring|fill|stroke|outline)-(?:accent|blush)\b|var\(--(?:accent|blush)/, () => false)).toEqual([]);
	});
});
