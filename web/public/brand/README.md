# Ready Set Mail logo files

Byte-identical copies from the brand asset pack in the website repository: `fellowship-dev/ready-set-mail-website`,
commit `fd0ff18`, folder `frontend/public/brand/readysetmail/` (its README has the full file list, clear-space and
recolouring rules, and the caveats: the wordmark is an outlined trace of raster lettering, not a font; the assets are not
BIMI-ready and not a trademark clearance). Copy new versions from there; never edit these files here.

| File | Used for |
| --- | --- |
| `svg/icon.svg` | The mark. `LogoMark` (`packages/ui/src/components/logo.tsx`) draws its paths: collapsed sidebar, phone top bar of the wizards. |
| `svg/lockup.svg`, `svg/lockup-dark.svg` | Mark plus wordmark for light and dark surfaces. `LogoLockup` draws them (sign-in and setup screens, the shell header, the wizard header from `sm`); the Worker's agent consent and setup pages and the report HTML render the same paths. |
| `favicon/favicon.ico`, `favicon/favicon.svg`, `favicon/apple-touch-icon.png` | `web/index.html`. |
| `favicon/favicon-16x16.png`, `favicon/favicon-32x32.png` | Raster favicons for anything that cannot use the ICO or SVG. |
| `png/lockup/lockup-light-640.png` | Emails (mail clients do not show SVG) and the PDF export header. |

One place to swap: the paths live in `packages/ui/src/components/logo-svg.ts`, which `packages/ui/test/brand.test.ts`
checks against `svg/*.svg` here. Rules: keep the included clear space, never recolour parts of the mark, the red is for the
flag only, and at 16 px use the favicon set.
