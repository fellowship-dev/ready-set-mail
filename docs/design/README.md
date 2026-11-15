# Design seed

Inputs for the v2 design system (`packages/ui`), shared by the dashboard and the website (readysetmail.com):

- Root `PRODUCT.md` and `DESIGN.md` (plus `.impeccable/design.json` and the dashboard surface brief in `web/.impeccable/surfaces/`): product context and the visual system for the dashboard, for the vendored Impeccable skill. They carry the brand shared with the website: personality, palette rules (brand blue `#0647FF` for action, navy `#06194B` ink, a lighter `--brand-ink` for text in dark mode; the logo's red only inside the logo), typography (Geist Sans / Geist Mono), principles and WCAG target.
- `site-globals.css`: the website's current light/dark token set and Tailwind 4 setup (parity snapshot of the website token set; the exact palette and its contrast evidence are documented in `packages/ui/README.md`).
- `brand/`: the RETIRED halo-envelope marks (simple, and a 3-colour SVG Tiny PS draft for BIMI), kept as history only. The current logo is the asset pack in `web/public/brand/` (see its README); do not use these.
