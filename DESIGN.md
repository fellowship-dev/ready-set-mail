---
name: Ready Set Mail Dashboard
description: Calm, competent, honest operator UI for email authentication, built on @ready-set-mail/ui.
colors:
  brand-blue: "#0647FF"
  brand-blue-hover: "#063EDB"
  brand-blue-active: "#0635B7"
  brand-navy: "#06194B"
  surface-page: "#F7F8FA"
  surface-card: "#FFFFFF"
  surface-raised: "#EFF1F6"
  surface-strong: "#E3E7F0"
  ink-primary: "#06194B"
  ink-secondary: "#525C75"
  ink-subtle: "#5D6782"
  brand-subtle: "#EBF0FF"
  on-brand: "#FFFFFF"
  line: "#D7DCE8"
  line-strong: "#B8C0D4"
  control-border: "#616B85"
  focus: "#0647FF"
  success: "#147A3A"
  success-subtle: "#ECFDF3"
  warning: "#AA4F08"
  warning-subtle: "#FFF7E6"
  danger: "#B91C1C"
  danger-subtle: "#FEF2F2"
  info: "#076A7E"
  info-subtle: "#E9F8FB"
  dark-surface-page: "#0B1120"
  dark-surface-card: "#141E38"
  dark-surface-raised: "#1C2847"
  dark-surface-strong: "#293658"
  dark-ink-primary: "#F4F6FB"
  dark-ink-secondary: "#A8B1C7"
  dark-ink-subtle: "#8A95B1"
  dark-brand: "#2E64FF"
  dark-brand-hover: "#0647FF"
  dark-brand-active: "#063EDB"
  dark-brand-ink: "#82A3FF"
  dark-brand-subtle: "#112660"
  dark-on-brand: "#FFFFFF"
  dark-line: "#333F5F"
  dark-line-strong: "#505D7E"
  dark-control-border: "#8A95B1"
  dark-focus: "#82A3FF"
  dark-success: "#4ADE80"
  dark-warning: "#FBBF24"
  dark-danger: "#F87171"
  dark-info: "#3CC2DD"
typography:
  page-title:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "1.875rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.025em"
  card-title:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.375
    letterSpacing: "-0.025em"
  stat-value:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "1.875rem"
    fontWeight: 700
    letterSpacing: "-0.025em"
  body:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.6
  body-large:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    letterSpacing: "0.025em"
  caption:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
  record:
    fontFamily: "Geist Mono Variable, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.625
rounded:
  sm: "6px"
  md: "10px"
  lg: "14px"
  xl: "20px"
  "2xl": "24px"
  full: "9999px"
spacing:
  base: "4px"
  field: "16px"
  card-mobile: "20px"
  card: "24px"
  section: "32px"
components:
  button-primary:
    backgroundColor: "{colors.brand-blue}"
    textColor: "{colors.on-brand}"
    rounded: "{rounded.md}"
    height: "40px"
    padding: "0 16px"
  button-primary-hover:
    backgroundColor: "{colors.brand-blue-hover}"
  button-secondary:
    backgroundColor: "{colors.surface-card}"
    textColor: "{colors.ink-primary}"
    rounded: "{rounded.md}"
    height: "40px"
    padding: "0 16px"
  button-secondary-hover:
    backgroundColor: "{colors.surface-raised}"
  button-danger:
    backgroundColor: "{colors.danger-subtle}"
    textColor: "{colors.danger}"
    rounded: "{rounded.md}"
    height: "40px"
    padding: "0 16px"
  card:
    backgroundColor: "{colors.surface-card}"
    textColor: "{colors.ink-primary}"
    rounded: "{rounded.lg}"
    padding: "24px"
  input:
    backgroundColor: "{colors.surface-card}"
    textColor: "{colors.ink-primary}"
    rounded: "{rounded.md}"
    height: "40px"
    padding: "0 12px"
  badge-success:
    backgroundColor: "{colors.success-subtle}"
    textColor: "{colors.success}"
    rounded: "{rounded.full}"
    padding: "2px 10px"
  nav-item-current:
    backgroundColor: "{colors.brand-subtle}"
    textColor: "{colors.brand-blue}"
    rounded: "{rounded.md}"
    height: "40px"
    padding: "0 12px"
  record-block:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.ink-primary}"
    typography: "{typography.record}"
    rounded: "{rounded.lg}"
    padding: "8px 16px"
---

# Design System: Ready Set Mail Dashboard

## Overview

The dashboard (`web/`) is built on the shared design system `@ready-set-mail/ui` (`packages/ui`), which is also used by the Ready Set Mail website. The brand is shared with the website: the name, the personality **Calm · Competent · Honest** (friendly, technical when needed), the palette roles below, Geist Sans and Geist Mono, the mailbox logo (see Logo and brand colours), WCAG AA, and no invented proof (no user counts, logos, badges or testimonials). Values here are read from `packages/ui/src/styles/{tokens,theme,base}.css` and the components, not from the website. The dashboard is the next step after registering from the website: the same person arrives from the site, so it continues the same brand rather than introducing a separate product look (Max, 2026-11-13).

Source-stated qualities: brand blue for action, navy ink, cool navy-tinted neutrals, soft radii, thin hairlines, little shadow, subtle motion, light mode by default with a full dark mode. Technical content (DNS records, error codes, addresses) is first-class and set in monospace. Rejected by the source: sky blue as a primary, mascot faces, enterprise-security imagery (shields, padlocks, badge walls), hype-landing devices, and cutesiness that undermines competence. Gradients are banned outright (see The No-Gradients Rule).

Creative North Star, overview mood language and any named metaphor: **open decision** (the repository records none, and none was supplied).

**Key Characteristics:**
- The brand-blue fill for the one primary action per section; everything else is neutral.
- Hairline-bordered cards on a cool-grey page; depth is tonal first, shadow second.
- Status is always icon + word, never colour alone.
- Visible 2px focus ring on every interactive element.

## Colors

A restrained palette: cool navy-tinted neutrals, one brand blue for action, and semantic status colours that only appear when they mean something. The light/dark pairs below are the values in `tokens.css`; frontmatter keys prefixed `dark-` are the dark-mode values. The brand changed on 2026-11-15 with the new logo (asset pack in `web/public/brand/`); the old navy/gold palette, its blush and the halo-envelope mark are retired.

### Primary
- **Brand Blue** (#0647FF): the action colour. Primary button fill (`--brand`, white label, 6.26:1), links and brand text (`--brand-ink`), focus ring, selected states (`--brand-subtle` tint with brand-ink text), progress. Hover #063EDB and pressed #0635B7 step toward the navy. In dark mode the fill is #2E64FF (white label 4.79:1, 3:1 edge on every dark surface), hover #0647FF, pressed #063EDB, and brand text, links and the focus ring use the lighter #82A3FF (4.5:1 on every dark surface).
- **Brand Navy** (#06194B): ink for headings and strong text on light surfaces (`ink-1`), and the hue every neutral is derived from.

### Logo-only
- **Logo Red** (#FF252B): the mailbox's raised flag, inside the logo files and nowhere else. Not a token; never a UI colour, button, link, badge or emphasis (`packages/ui/test/brand.test.ts` fails if it appears outside the logo data).

### Neutral
- **Page, Card, Raised, Strong** (light #F7F8FA / #FFFFFF / #EFF1F6 / #E3E7F0; dark #0B1120 / #141E38 / #1C2847 / #293658): `surface-0..3`.
- **Ink 1 / 2 / 3** (light #06194B / #525C75 / #5D6782; dark #F4F6FB / #A8B1C7 / #8A95B1): primary, secondary and subtle text.
- **Hairline** (#D7DCE8 light, #333F5F dark) and **Strong hairline** (#B8C0D4, #505D7E): borders and dividers.
- **Control edge** (#616B85 light, #8A95B1 dark): form-control borders, added because the strong hairline is about 1.5:1 on white and WCAG 1.4.11 needs 3:1.
- **Brand tint** (#EBF0FF light, #112660 dark): selected rows and navigation, focus backgrounds.
- Derivation: the neutrals keep the lightness and saturation of the previous set and take the navy's hue (223.5°).

### Semantic
- **Success** (#147A3A / #4ADE80), **Warning** (#AA4F08 / #FBBF24, e.g. DMARC `p=none`), **Danger** (#B91C1C / #F87171), **Info** (#076A7E / #3CC2DD, teal) with tints (#ECFDF3, #FFF7E6, #FEF2F2, #E9F8FB / #0F2A1A, #2A2110, #2C1416, #0E2A31). Light success and warning were darkened from #15803D and #B45309 to reach 4.5:1 on every surface.

### Named Rules
**The Fill-Versus-Ink Rule.** `brand` is a fill and takes `brand-fg` labels (white); brand-coloured text and links use `brand-ink`. In dark mode the fill and its hover are too dark for text (`forbiddenPairs`).
**The Status-Is-Not-Brand Rule.** Status colours keep their meaning and stay apart from the brand: notes and information are teal `info`, never the brand blue, so a note never looks like an action or a selection; the danger red is a darker crimson than the logo's red and is used only for failures, never decoratively; a primary button never takes a status colour. No gold or yellow except the warning status.
**The Logo-Red Rule.** The logo's red lives only inside the logo.
**The Action-Fill Rule.** A filled brand-blue surface means "press this" or "you are here": only primary actions, the selected navigation marker, checked controls and wizard progress use it, never levels, badges, counts, step markers or other states (`packages/ui/test/brand.test.ts` checks the unprefixed `bg-brand`/`bg-brand-ink` uses).
**The No-Colour-Alone Rule.** Every status pairs colour with an icon and a word.
**The No-Gradients Rule.** No gradients, anywhere, on the dashboard or the website (Max, 2026-11-13): no gradient fills, text, dividers, borders, loading shimmers or scroll shadows. Every colour is a solid token. This is a hard rule, not a preference; existing gradients in code are known debt to remove, not precedent.

The dashboard has none: skeletons are a solid `surface-3` opacity pulse (`ia-pulse`), and an overflowing table marks the edge that hides columns with a `control-border` hairline plus a "Scroll sideways" label. `packages/ui/test/tokens.test.ts` fails if a gradient appears in `packages/ui/src` or `web/src`.

Known gradient debt (to remove):
- Website (same rule): `frontend/app/globals.css` `.shimmer` and `.section-rule` in fellowship-dev/ready-set-mail-website; the reference snapshot `docs/design/site-globals.css` copies `.shimmer` and is not shipped (its `.section-rule` is now a solid `--brand`, because the gold accent it faded into is retired).

## Logo and brand colours

The mark is a blue mailbox with a raised red flag; the lockup is the mark plus the lowercase wordmark "readysetmail" in navy. The files are the brand asset pack (website repo `fellowship-dev/ready-set-mail-website` at `fd0ff18`, `frontend/public/brand/readysetmail/`), copied byte-identical to `web/public/brand/` (README there lists which file is used where). `packages/ui/src/components/logo-svg.ts` carries their paths as data and is the one place to swap the logo; `LogoLockup` and `LogoMark` render it, the Worker's agent consent and setup pages and the report HTML render the same paths, and `packages/ui/test/brand.test.ts` rebuilds the SVG files from that data and fails on any difference.

- **Lockup** (`LogoLockup`, svg/lockup.svg on light surfaces, svg/lockup-dark.svg on dark ones; the `--logo-wordmark` token switches the wordmark between #06194B and #FFFFFF with the theme) wherever the product name and mark appear together and there is width: sign-in and setup screens, the shell header, the wizard header from `sm`, the PDF cover (png/lockup/lockup-light-640.png), the agent consent page, the report. Emails carry no image: their header is the wordmark "readysetmail" as navy Arial text on a light cell, with the brand-blue rule under it, so it holds with images blocked and in forced dark mode.
- **Icon** (`LogoMark`, svg/icon.svg) where only a mark fits: the collapsed sidebar, the phone wizard header, avatar-size uses. At 16 px use the favicon set (favicon.ico, favicon.svg, apple-touch-icon.png in `web/index.html`).
- Keep the clear space included in the files; never recolour parts of the mark, never put it on a tile, never add effects. The monochrome variants are for places that require a single colour only (none in the dashboard today).
- The wordmark is an outlined trace of the approved lettering: do not try to match it with a font; product typography stays Geist. The assets are not BIMI-ready (no SVG Tiny PS) and not a trademark clearance.

## Typography

**Sans:** Geist Sans (Geist Variable; fallback `ui-sans-serif, system-ui, -apple-system, sans-serif`) for UI and prose.
**Mono:** Geist Mono (Geist Mono Variable; fallback `ui-monospace, SFMono-Regular, Menlo, monospace`) for DNS records, addresses and codes.

Fonts are bundled through `@fontsource-variable/*`; no CDN at runtime. Body line-height is 1.6 with antialiased smoothing.

### Hierarchy
- **Page title** (600, 1.5rem, 1.875rem from `sm`, leading-tight): `PageHeader` h1; tight tracking, balanced wrapping, `overflow-wrap:anywhere` so long domains wrap.
- **Card / section title** (600, 1.125rem, leading-snug): `CardTitle` and section headings.
- **Stat value** (700, 1.875rem, tabular figures): `Stat`.
- **Body** (400, 0.875rem or 1rem, 1.6): working text; descriptions are `ink-2`, capped at `max-w-prose`.
- **Label** (600, 0.75rem, wide tracking, uppercase): nav section labels and record field names.
- **Caption** (0.75rem): hints and metadata.
- **Record** (Geist Mono, 0.875rem, leading-relaxed): record values.

### Named Rules
**The Records-Are-Content Rule.** Anything copy-pasteable is monospace, selectable and copyable.

## Layout

A 4px spacing grid. Page sections are separated by `space-y-8` (32px); card padding is `p-5` (20px), `sm:p-6` (24px); form fields stack at `space-y-4` with label, control and hint at `space-y-2`; one primary action per section. The shell (`AppShell`) is a sidebar with workspace switcher, grouped navigation and footer, plus a top bar for breadcrumb/domain switcher and theme/account controls. The sidebar can collapse to icons; on phones it becomes a focus-trapped drawer. Auth screens use a centred card from `sm`, full-width from the top on phones. Mobile layout is checked at 375px. Container widths and breakpoints beyond Tailwind defaults: **open decision** (none are defined in `packages/ui`).

## Elevation & Depth

Tonal layering with hairlines first; shadows are quiet and used for floating layers. Depth ladder: page (`surface-0`), card (`surface-1` plus hairline), raised and inset areas (`surface-2`, `surface-3`).

### Shadow Vocabulary
- **Soft** (`--shadow-sm`: `0 1px 2px 0 rgb(15 23 42 / 0.05)`; dark `rgb(0 0 0 / 0.3)`): cards.
- **Lift** (`--shadow-md`): the auth card only.
- **Pop** (`--shadow-lg`): menus and toasts.
- **Float** (`--shadow-xl`): dialogs.

### Named Rules
**The Quiet-Shadow Rule.** Cards carry only the soft shadow; larger shadows are for layers that float over content.

## Shapes

Soft radii, thin 1px hairlines. `rounded-md` (10px) for controls, buttons, nav items and menus; `rounded-lg` (14px) for cards, alerts, tables and record blocks; `rounded-xl` (20px) dialogs; `rounded-full` for badges, pills and icon discs; `rounded-sm` (6px) for inline links and menu items. The logo is never put on a tile or rounded (see Logo and brand colours).

## Components

Character source: `packages/ui/README.md` ("sober", status never by colour alone). Detailed behaviour per the code:

### Buttons
- **Shape:** 10px radius; heights sm 32, md 40, lg 48px; text `sm` (lg is `base`); icons 16px (20px at lg).
- **Primary:** brand fill with `brand-fg` label, hover `brand-hover`.
- **Secondary:** card surface, strong hairline, hover `surface-2`. **Ghost:** transparent, hover `surface-2`. **Danger:** `danger-subtle` fill with danger text and border. **Link:** brand-ink, underline offset 4px.
- **States:** colour transition only; disabled is 50% opacity with no pointer events.

### Cards / Containers
- 14px radius, 1px hairline, card surface, soft shadow. Header and content padding 20px (24px from `sm`); optional footer with top hairline on a half-strength `surface-2`. Card titles are `text-lg` semibold.

### Inputs / Fields
- 40px high, 10px radius, `control-border` edge on the card surface, placeholder `ink-3`, 12px horizontal padding.
- **Invalid:** `aria-invalid` switches to a 2px danger border. **Disabled:** 50% opacity.

### Navigation
- Items 40px high, 10px radius, `text-sm` medium, icons 20px; default `ink-2`, hover `surface-2` with `ink-1`. Current item uses `aria-current="page"`, brand tint, semibold weight and a 2px left marker, never colour alone. Section labels are small uppercase `ink-2`. Collapsed state shows icons with sr-only labels and tooltips. Tabs use a bottom border: 2px `brand-ink` when active.

### Status and badges
- **Badge:** pill, 12px medium text, variants neutral, brand (roles, "Recommended"), info (notes), success, warning, danger, outline; paired with an icon or word.
- **StatusDot:** per-status Lucide icon (check, triangle, x, dashed circle, info) plus label. **Alert:** tinted card with icon and title; danger and warning use `role="alert"`. **CheckResult** distinguishes "Lookup failed" from "Not found". **LevelCard** shows the Delivering, Authenticated and Protected levels with findings.

### Shared status words (with the website)

One vocabulary for a domain's state on the website check and in the dashboard (`packages/ui/src/components/status.tsx`, mirroring the website's `frontend/components/site/Status.tsx`: same keys, words and order). `StatusLabel` renders the icon plus the visible word; the colour only repeats it. The level stays the structure underneath: a row or page shows the word **and** the LevelLadder.

| Word | Key | Means | Who acts next | Icon, tone | Existing states that read as it |
|---|---|---|---|---|---|
| Needs attention | `attention` | Public DNS or the reports show a problem that affects mail (no SPF or DMARC, an ignored DMARC record, a domain that does not resolve, enforced mail failing) | You or your DNS manager | XCircle, danger | CheckResult `fail`, `missing`; Finding `fail`, `missing`; StatusDot `fail`; Badge `danger` |
| Awaiting your approval | `approval` | A tightening step is proposed and the evidence supports it (p=none to quarantine, quarantine to reject) | An owner or admin | CircleArrowRight, warning | StatusDot `warn`; Badge `warning` |
| Worth fixing | `improve` | Works, could be safer (p=none, failing senders, pct below 100) | You decide when | AlertTriangle, warning | CheckResult `warn`; Finding `warn`; StatusDot `warn`; Badge `warning` |
| Unknown | `unknown` | Cannot be settled yet: not checked, lookup failed, DKIM selector not discoverable, reports not connected. Never shown as "Not found" | You, or a retry | CircleHelp, ink-2 | CheckResult `error`; Finding `unknown`; StatusDot `unknown`; Badge `neutral` |
| Still gathering evidence | `gathering` | Reports can arrive but too few have | Nobody yet | Clock, ink-2 | StatusDot `unknown`; Badge `neutral` |
| Change prepared | `prepared` | A record is written (hosted zone) and public DNS does not point to it yet | You publish it | FileText, info | StatusDot `info`; Badge `info` |
| Verified | `verified` | The measured check passes, with its scope named ("from public DNS", "and reports") | Nobody | CheckCircle2, success | CheckResult `pass`; Finding `pass`; StatusDot `ok`; Badge `success` |
| Note | `note` | Information only | Nobody | Info, info | CheckResult `neutral`; StatusDot `info`; Badge `info` |

Rules: a whole result takes its most urgent state (`worstStatus`, order as in the table). "Still gathering evidence" appears only where reports can arrive; before that, report-dependent checks are Unknown. The per-check words inside CheckResult ("Pass", "Not found", "Lookup failed") stay as details under these states.

### LevelLadder (signature)
- Delivering → Authenticated → Protected as three named rungs (`packages/ui/src/components/level-ladder.tsx`), the visual anchor of every overview row and the domain page. Reached rungs are thin `ink-3` bars with an `ink-2` check (a state, not an action: never the brand fill); the **current rung's name is bold with an `ink-3` outline**. The current step markers in "Get to your first answer" and "Do this next" use the brand tint with a `brand-ink` label and outline, and the DMARC rollout bars use `ink-3`.
- `level={null}` is its own state: dashed empty rungs and "Level not known yet" in words. A domain never read from DNS, a failed check or a domain that does not resolve never shows a level.
- `role="progressbar"` with `aria-valuetext` ("Level 1 of 2: Authenticated").
- A level name is never cut. The rungs sit side by side when the ladder's own box is at least 22rem (a container query, so it holds in a row, a card or a claim preview) and stack as three short lines below that. Rows and "Where it stands" put the ladder in its own 22rem column from `lg`, and above the text below `lg`.

### Empty states
- `EmptyState` is a quiet, left-aligned note in the page flow: the title says what is empty and why ("No reports for this period"), the description the one thing to do next and what appears once it is done, plus at most one action. No icon in a circle, no dashed frame, no slogan, and no reassurance a region cannot back with evidence ("Nothing to fix" only with the number of messages it was judged from).

### Collapsed sections (Disclosure)
- Long or secondary content (DNS records, reports, failing senders, rollout, the health report, DNS tools) sits behind an h2 button that says what is inside ("DNS records: DMARC, SPF and 12 DKIM keys, read live from public DNS."), WAI-ARIA accordion pattern (`aria-expanded`, `aria-controls`). Content stays mounted while closed. A Section inside a Disclosure renders no second heading, and nested headings use `useHeadingTag`, so a page reads h1 → h2 → h3 with no skipped level. Long lists inside collapse behind their count ("Show 12 DKIM records").

### DNS Record Block (signature)
- Raised-surface block with 14px radius; each field (Type, Name, Value, optional TTL) is a label/value row in Geist Mono with a copy icon button on Name and Value. Copy feedback is a check icon plus a polite live-region announcement ("Copied to clipboard") and resets after 2 seconds.

### Motion
- `ia-fade-in` 150ms, `ia-pop` 120ms, `ia-scale-in` 200ms and `ia-slide-up` 200ms (`cubic-bezier(0.16, 1, 0.3, 1)`), `ia-slide-left` 220ms. `ia-pulse` 1.5s for skeletons: a solid `surface-3` fill pulsing between full and half opacity, held still under reduced motion. `prefers-reduced-motion` reduces all animation and transitions to 0.01ms.

## Page structure: "Am I done?"

- **Overview:** the h1, then one sentence that answers "Am I done?" for the workspace ("Not yet. Of 9 domains, 2 need attention, 1 is awaiting your approval…"; "Done, from public DNS: …" only when every domain is Verified, with its scope). Then, while the workspace is not done and the viewer can write, "Get to your first answer": the few real steps, each in the state the data shows (Done, To do, Waiting, Unknown), gone once all are done. Then one row per domain, most urgent first, a subdomain under its parent: name and state word, the LevelLadder, one sentence of what is true now, the report evidence, when DNS was checked, and exactly one next action with who acts. No KPI strip.
- **Domain page:** "Do this next" first (one to three actions as Do this / Why / Who, most urgent first, with the exact record offered when there is one), then "Where it stands" (ladder, state, evidence, checked when), then collapsed sections. The first screen answers what to do.
- **One DMARC rule for every surface.** The policy in force for a name and its next step come from one module (`packages/dns-checks/src/dmarc-next-step.ts`: `policyInForce`, `dmarcSteps`), called by the overview row, the domain page and the agent tools on the same stored facts and 30-day totals, so they cannot disagree (`web/test/verdict.test.ts` renders one table through both pages). The policy in force is the name's own record, else its organizational parent's `sp=`, else the parent's `p=`, with the parent's `pct=`. The ladder is the same for own and inherited names: none → quarantine → reject, then pct=100, each rung waiting on the same report evidence (a reports address, a record that sends reports here, reports that arrived, their pass share). An inherited change names the tag and record (`sp=` at `_dmarc.<parent>`), what else it affects, pct while below 100, and the alternative of the name's own record. Only p=reject on all mail is "Nothing to do"; p=quarantine waits on p=reject. Without a current reports address no pass share is shown.

## Do's and Don'ts

### Do:
- **Do** use the brand fill (`bg-brand text-brand-fg`) for the single primary action of a section and `text-brand-ink` for brand-coloured text.
- **Do** pair every status with an icon and a word.
- **Do** keep the 2px `--focus` outline on every interactive element.
- **Do** show DNS records, addresses and codes in Geist Mono with a copy control.
- **Do** use `control-border` for form edges and keep text pairs at 4.5:1 (3:1 for large text and UI borders).
- **Do** honour `prefers-reduced-motion`.
- **Do** use the shared status words (`StatusLabel`) for a domain's state, with the LevelLadder under them.
- **Do** say why a region is empty and the one thing to do next.

### Don't:
- **Don't** use sky blue as a primary or a mascot face.
- **Don't** use gradients anywhere: fills, text, dividers, borders, loading shimmers and scroll shadows are solid colours.
- **Don't** use the logo's red, gold or yellow in the UI (warning amber is the only yellow-family colour), or the brand blue for a status.
- **Don't** use enterprise-security imagery (shields, padlocks, badge walls) or hype-landing devices (counters, "trusted by").
- **Don't** use the dark-mode `brand` fill or `brand-hover` as text (fails AA; listed in `forbiddenPairs`) or `--line-strong` for form-control edges.
- **Don't** invent proof: no user counts, customer logos or testimonials.
- **Don't** recolour parts of the logo, put it on a tile, add effects, crowd its clear space, or set the wordmark in a font.
- **Don't** add KPI tiles, icon-in-a-circle empty states or a second status vocabulary.
- **Don't** show Unknown as "Not found", or a level for a domain that was never read.
