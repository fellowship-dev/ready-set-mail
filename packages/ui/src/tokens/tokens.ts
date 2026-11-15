/** Design tokens for JS consumers (charts, canvas, email templates). Mirrors styles/tokens.css. */

export const lightColors = {
	"surface-0": "#f7f8fa",
	"surface-1": "#ffffff",
	"surface-2": "#eff1f6",
	"surface-3": "#e3e7f0",
	"ink-1": "#06194b",
	"ink-2": "#525c75",
	"ink-3": "#5d6782",
	brand: "#0647ff",
	"brand-hover": "#063edb",
	"brand-active": "#0635b7",
	"brand-ink": "#0647ff",
	"brand-subtle": "#ebf0ff",
	"brand-fg": "#ffffff",
	success: "#147a3a",
	"success-subtle": "#ecfdf3",
	warning: "#aa4f08",
	"warning-subtle": "#fff7e6",
	danger: "#b91c1c",
	"danger-subtle": "#fef2f2",
	info: "#076a7e",
	"info-subtle": "#e9f8fb",
	line: "#d7dce8",
	"line-strong": "#b8c0d4",
	"logo-wordmark": "#06194b",
	"control-border": "#616b85",
	focus: "#0647ff",
} as const;

export type ColorToken = keyof typeof lightColors;

/** Dark values; tokens absent here keep their light value (as on the website). */
export const darkOverrides = {
	"surface-0": "#0b1120",
	"surface-1": "#141e38",
	"surface-2": "#1c2847",
	"surface-3": "#293658",
	"ink-1": "#f4f6fb",
	"ink-2": "#a8b1c7",
	"ink-3": "#8a95b1",
	brand: "#2e64ff",
	"brand-hover": "#0647ff",
	"brand-active": "#063edb",
	"brand-ink": "#82a3ff",
	"brand-subtle": "#112660",
	"brand-fg": "#ffffff",
	success: "#4ade80",
	"success-subtle": "#0f2a1a",
	warning: "#fbbf24",
	"warning-subtle": "#2a2110",
	danger: "#f87171",
	"danger-subtle": "#2c1416",
	info: "#3cc2dd",
	"info-subtle": "#0e2a31",
	line: "#333f5f",
	"line-strong": "#505d7e",
	"logo-wordmark": "#ffffff",
	"control-border": "#8a95b1",
	focus: "#82a3ff",
} as const satisfies Partial<Record<ColorToken, string>>;

export const darkColors: Record<ColorToken, string> = { ...lightColors, ...darkOverrides };

export const colors = { light: lightColors, dark: darkColors } as const;

export const radii = {
	sm: "0.375rem",
	md: "0.625rem",
	lg: "0.875rem",
	xl: "1.25rem",
	"2xl": "1.5rem",
	full: "9999px",
} as const;

export const shadows = {
	light: {
		sm: "0 1px 2px 0 rgb(15 23 42 / 0.05)",
		md: "0 4px 6px -1px rgb(15 23 42 / 0.07), 0 2px 4px -2px rgb(15 23 42 / 0.05)",
		lg: "0 10px 15px -3px rgb(15 23 42 / 0.07), 0 4px 6px -4px rgb(15 23 42 / 0.05)",
		xl: "0 20px 25px -5px rgb(15 23 42 / 0.08), 0 8px 10px -6px rgb(15 23 42 / 0.04)",
	},
	dark: {
		sm: "0 1px 2px 0 rgb(0 0 0 / 0.3)",
		md: "0 4px 6px -1px rgb(0 0 0 / 0.4), 0 2px 4px -2px rgb(0 0 0 / 0.3)",
		lg: "0 10px 15px -3px rgb(0 0 0 / 0.4), 0 4px 6px -4px rgb(0 0 0 / 0.3)",
		xl: "0 20px 25px -5px rgb(0 0 0 / 0.5), 0 8px 10px -6px rgb(0 0 0 / 0.3)",
	},
} as const;

export const fonts = {
	sans: '"Geist Variable", ui-sans-serif, system-ui, -apple-system, sans-serif',
	mono: '"Geist Mono Variable", ui-monospace, SFMono-Regular, Menlo, monospace',
} as const;

/** CSS custom-property reference for a colour token: `cssVar("brand-ink")` → `var(--brand-ink)`. */
export const cssVar = (token: ColorToken): string =>
	token === "control-border" ? "var(--control-border)" : `var(--${token})`;

/** Contrast pairs the design commits to (checked in test/tokens.test.ts, in both modes). */
export const contrastPairs: ReadonlyArray<{ fg: ColorToken; bg: ColorToken; min: number; note: string }> = [
	{ fg: "ink-1", bg: "surface-0", min: 4.5, note: "body on page" },
	{ fg: "ink-1", bg: "surface-1", min: 4.5, note: "body on card" },
	{ fg: "ink-1", bg: "surface-2", min: 4.5, note: "body on raised" },
	{ fg: "ink-1", bg: "surface-3", min: 4.5, note: "body on strongest surface" },
	{ fg: "ink-2", bg: "surface-0", min: 4.5, note: "secondary on page" },
	{ fg: "ink-2", bg: "surface-1", min: 4.5, note: "secondary on card" },
	{ fg: "ink-2", bg: "surface-2", min: 4.5, note: "secondary on raised" },
	{ fg: "ink-2", bg: "surface-3", min: 4.5, note: "secondary on strongest surface" },
	{ fg: "ink-3", bg: "surface-0", min: 4.5, note: "subtle on page" },
	{ fg: "ink-3", bg: "surface-1", min: 4.5, note: "subtle on card" },
	{ fg: "ink-3", bg: "surface-2", min: 4.5, note: "subtle on raised (small text)" },
	{ fg: "brand-fg", bg: "brand", min: 4.5, note: "primary button label" },
	{ fg: "brand-fg", bg: "brand-hover", min: 4.5, note: "primary button label, hover" },
	{ fg: "brand-fg", bg: "brand-active", min: 4.5, note: "primary button label, pressed" },
	{ fg: "brand-ink", bg: "surface-0", min: 4.5, note: "link on page" },
	{ fg: "brand-ink", bg: "surface-1", min: 4.5, note: "link on card" },
	{ fg: "brand-ink", bg: "surface-2", min: 4.5, note: "link on raised" },
	{ fg: "brand-ink", bg: "surface-3", min: 4.5, note: "link on strongest surface" },
	{ fg: "brand-ink", bg: "brand-subtle", min: 4.5, note: "selected nav item / brand badge text on tint" },
	{ fg: "ink-1", bg: "brand-subtle", min: 4.5, note: "text on selected row" },
	{ fg: "ink-2", bg: "brand-subtle", min: 4.5, note: "secondary on selected row" },
	{ fg: "success", bg: "surface-0", min: 4.5, note: "pass text on page" },
	{ fg: "success", bg: "surface-1", min: 4.5, note: "pass text on card" },
	{ fg: "success", bg: "surface-2", min: 4.5, note: "pass text on raised" },
	{ fg: "success", bg: "success-subtle", min: 4.5, note: "pass text on tint" },
	{ fg: "warning", bg: "surface-0", min: 4.5, note: "warn text on page" },
	{ fg: "warning", bg: "surface-1", min: 4.5, note: "warn text on card" },
	{ fg: "warning", bg: "surface-2", min: 4.5, note: "warn text on raised" },
	{ fg: "warning", bg: "warning-subtle", min: 4.5, note: "warn text on tint" },
	{ fg: "danger", bg: "surface-0", min: 4.5, note: "fail text on page" },
	{ fg: "danger", bg: "surface-1", min: 4.5, note: "fail text on card" },
	{ fg: "danger", bg: "surface-2", min: 4.5, note: "fail text on raised" },
	{ fg: "danger", bg: "danger-subtle", min: 4.5, note: "fail text on tint" },
	{ fg: "info", bg: "surface-0", min: 4.5, note: "note text on page" },
	{ fg: "info", bg: "surface-1", min: 4.5, note: "note text on card" },
	{ fg: "info", bg: "surface-2", min: 4.5, note: "note text on raised" },
	{ fg: "info", bg: "info-subtle", min: 4.5, note: "note badge / info alert icon on tint" },
	{ fg: "ink-1", bg: "success-subtle", min: 4.5, note: "alert body on pass tint" },
	{ fg: "ink-1", bg: "warning-subtle", min: 4.5, note: "alert body on warn tint" },
	{ fg: "ink-1", bg: "danger-subtle", min: 4.5, note: "alert body on fail tint" },
	{ fg: "ink-1", bg: "info-subtle", min: 4.5, note: "alert body on info tint" },
	{ fg: "control-border", bg: "surface-1", min: 3, note: "input edge on card" },
	{ fg: "control-border", bg: "surface-0", min: 3, note: "input edge on page" },
	{ fg: "focus", bg: "surface-0", min: 3, note: "focus ring on page" },
	{ fg: "focus", bg: "surface-1", min: 3, note: "focus ring on card" },
	{ fg: "focus", bg: "surface-2", min: 3, note: "focus ring on raised" },
	{ fg: "focus", bg: "brand-subtle", min: 3, note: "focus ring on selected nav item" },
	{ fg: "brand", bg: "surface-0", min: 3, note: "primary fill / switch / checkbox on page" },
	{ fg: "brand", bg: "surface-1", min: 3, note: "primary fill / switch / checkbox on card" },
	{ fg: "brand", bg: "surface-2", min: 3, note: "primary fill / switch / checkbox on raised" },
	{ fg: "brand-ink", bg: "surface-3", min: 3, note: "progress fill on its empty track" },
	{ fg: "logo-wordmark", bg: "surface-0", min: 4.5, note: "lockup wordmark on page" },
	{ fg: "logo-wordmark", bg: "surface-1", min: 4.5, note: "lockup wordmark on card / header" },
];

/**
 * Pairs that FAIL AA, so components avoid them (checked to stay failing, so the list cannot go stale):
 * - in dark mode the brand FILL (#2e64ff) and its hover (#0647ff) are too dark for text on the dark surfaces:
 *   brand-coloured text always uses --brand-ink.
 */
export const forbiddenPairs: ReadonlyArray<{ fg: ColorToken; bg: ColorToken; mode: "light" | "dark" }> = [
	{ fg: "brand", bg: "surface-1", mode: "dark" },
	{ fg: "brand-hover", bg: "surface-1", mode: "dark" },
];
