# @ready-set-mail/ui

Design system for Ready Set Mail (dashboard and website): tokens, a Tailwind 4 theme and React 19 components.
Token values are shared with the website (parity snapshot `docs/design/site-globals.css`); `test/tokens.test.ts` fails if they drift.

## Use

```css
/* app.css */
@import "tailwindcss";
@import "@ready-set-mail/ui/styles.css"; /* tokens (light/dark), @theme, base styles, bundled Geist fonts, @source for the components */
```

```tsx
import { Button, LevelCard, RecordBlock } from "@ready-set-mail/ui";
import { colors } from "@ready-set-mail/ui/tokens"; // JS consumers
```

- Light by default, follows `prefers-color-scheme`. Force a theme with `data-theme="light|dark"` on `<html>` or any wrapper.
- Fonts (Geist Sans / Geist Mono, OFL-1.1) ship through `@fontsource-variable/*`: no CDN at runtime.
- Components are ESM (`.js` specifiers, loadable in Node). Interactive ones carry `"use client"`; for React Server Components import pure pieces (Badge, Card, StatusDot, LevelCard, Alert, Table, Stat, tokens …) from `@ready-set-mail/ui/server`.
- Utilities: `bg-surface-1`, `text-ink-2`, `border-line`, `bg-brand text-brand-fg`, `text-brand-ink`, `shadow-soft|lift|pop|float`, `font-mono`.

## Rules baked in

- Brand blue `#0647FF` is the action colour (primary buttons, links, focus, selected states, progress); navy `#06194B` is the ink. `brand` is a FILL with white `brand-fg` labels; brand-coloured text and links use `brand-ink` (lighter in dark mode). The logo's red `#FF252B` is not a token: it appears only inside the logo. No gold, gradients or mascot faces.
- Status colours keep their meaning and never borrow the brand: notes and information use `info` (teal), not the brand blue.
- Status never relies on colour: icon + word (CheckResult, LevelCard findings, StatusDot label, Alert).
- "Lookup failed" (`error`) is distinct from "Not found" (`missing`) in CheckResult.
- Pairs that fail AA are listed in `forbiddenPairs` (tokens.ts) and avoided: the dark-mode brand fill and its hover as
  text on dark surfaces (use `brand-ink`). Form controls use the added
  `--control-border` token because `--line-strong` is ~1.5:1 on white (WCAG 1.4.11 needs 3:1).

## Foundations

### Palette (exact values; `tokens.css` is the source, `tokens.ts` and `docs/design/site-globals.css` mirror it)

| Token | Light | Dark |
| --- | --- | --- |
| surface-0 / 1 / 2 / 3 | #F7F8FA / #FFFFFF / #EFF1F6 / #E3E7F0 | #0B1120 / #141E38 / #1C2847 / #293658 |
| ink-1 / 2 / 3 | #06194B / #525C75 / #5D6782 | #F4F6FB / #A8B1C7 / #8A95B1 |
| brand (fill) | #0647FF | #2E64FF |
| brand-hover / brand-active | #063EDB / #0635B7 | #0647FF / #063EDB |
| brand-fg (label on the fill) | #FFFFFF | #FFFFFF |
| brand-ink (links, brand text) | #0647FF | #82A3FF |
| brand-subtle (selected rows, focus tint) | #EBF0FF | #112660 |
| line / line-strong | #D7DCE8 / #B8C0D4 | #333F5F / #505D7E |
| control-border (form edges, 3:1) | #616B85 | #8A95B1 |
| focus (ring) | #0647FF | #82A3FF |
| logo-wordmark (lockup wordmark only) | #06194B | #FFFFFF |

How they are derived: the neutrals (surfaces, ink-2/3, lines, control-border) keep the lightness and saturation of the previous set, re-hued to the navy's hue (223.5°). Hover and pressed step 20% and 40% toward the navy; in dark mode the fill is the brand blue lifted 16% toward white (the least that keeps a 3:1 edge on surface-0/1/2 with a 4.5:1 white label), hover and pressed step back down to #0647FF and #063EDB, and `brand-ink` is the brand blue mixed 50% with white (4.5:1 on every dark surface). `brand-subtle` is 8% brand on white (light) and 20% brand on surface-1 (dark).

Contrast evidence lives in `contrastPairs` (checked per mode in `test/tokens.test.ts`): text ≥ 4.5:1 on every surface and tint it is used on, UI fills, focus and control edges ≥ 3:1. White on #0647FF is 6.26:1 (AA, not AAA): the earlier "brand label ≥ 7:1" pair was dropped because the brand blue is fixed.

### Semantic status

Status always pairs colour with an icon and a word (Alert, CheckResult, StatusDot, LevelCard).

| Status | Text/icon (light / dark) | Tint (light / dark) | Use |
| --- | --- | --- | --- |
| success | #147A3A / #4ADE80 | #ECFDF3 / #0F2A1A | check passed, verified |
| warning | #AA4F08 / #FBBF24 | #FFF7E6 / #2A2110 | works but needs attention (e.g. DMARC `p=none`) |
| danger | #B91C1C / #F87171 | #FEF2F2 / #2C1416 | failed, blocked, destructive |
| info | #076A7E / #3CC2DD | #E9F8FB / #0E2A31 | notes, neutral notices, sample data (teal: never the brand blue) |

Light success/warning were darkened from #15803D/#B45309 so status text meets 4.5:1 on every surface including `surface-2` (4.82:1 / 4.90:1); dark values are unchanged.

### Typography, spacing, radius, motion

- Type: Geist Sans for UI, Geist Mono for DNS records, addresses and codes. Scale: page title `text-2xl sm:text-3xl` semibold, section `text-lg` semibold, card title `text-lg` semibold, body `text-sm`/`text-base`, caption `text-xs`. Headings use `tracking-tight`, `text-balance` and `overflow-wrap:anywhere` so long domains wrap instead of overflowing.
- Spacing: 4px grid. Page sections `space-y-8`; card padding `p-5 sm:p-6`; form fields `space-y-4` with label→control→hint `space-y-2`; one primary action per section.
- Radius: `rounded-md` controls and buttons, `rounded-lg` cards, alerts and record blocks, `rounded-full` pills and icon discs. Shadows stay quiet (`shadow-soft`; `shadow-lift` only for the auth card).
- Motion: 120–220ms ease-out (`ia-fade-in`, `ia-slide-left`, `ia-pop`), colour transitions only on hover. `prefers-reduced-motion` removes all animation and transitions (base.css).
- Focus: 2px `--focus` outline with offset on every interactive element; never remove it. Selected navigation uses `aria-current="page"` plus tint, weight and a 2px marker, not colour alone.

### Logo

The files are the brand asset pack, byte-identical, in `web/public/brand/` (README there). `components/logo-svg.ts` holds their paths as data (plain TS, also used by the Worker's pages); `test/brand.test.ts` rebuilds the SVG files from it and fails on any difference.

- `LogoLockup`: mark plus the "readysetmail" wordmark, viewBox 1526×347 (about 4.4:1, clear space included). Use it wherever the name and mark appear together and there is width (sign-in, setup, the shell header). Size by height (`h-8 w-auto`). `surface="auto"` (default) switches the wordmark between navy and white with the theme (`--logo-wordmark`), exactly lockup.svg and lockup-dark.svg; it is named "Ready Set Mail" unless `aria-hidden`.
- `LogoMark`: the icon alone, viewBox 414×414, transparent, for places where only a mark fits (collapsed sidebar, avatar size). At 16 px use the favicon set.
- Never recolour parts of the mark, add a tile or effects, or set the wordmark in a font.

### Shared screens

`AuthLayout` + `Field` (sign-in, owner setup, reset) live here; `web/src/pages/auth/AuthLayout.tsx` re-exports them. Phones get a full-width card starting at the top; from `sm` the card is centred.

## Scripts

```
npm run build          # tsc → dist/ (+ CSS)
npm test               # build, then vitest: render, axe, token sync, contrast, built-dist Node smoke test
npm run dev:gallery    # gallery on http://127.0.0.1:5199
npm run build:gallery
npm run screenshots    # needs Chromium: PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers npx playwright install chromium
node scripts/evidence.mjs <label> <outDir> [baseUrl]   # per-route screenshots at 375/768/1440, overflow, axe (with contrast), keyboard, drawer, copy checks
```

Gallery routes (all synthetic `.test` data; add `?fixture=long` for worst-case lengths, `?theme=light|dark`): `#/components`, `#/signin`, `#/setup-owner`, `#/overview-empty`, `#/overview`, `#/wizard` (DNS record step), `#/loading`, `#/error`.

Only the desktop overview and wizard shots (light + dark, WebP) are committed in `gallery/screenshots/`; `npm run screenshots` regenerates all of them locally.
