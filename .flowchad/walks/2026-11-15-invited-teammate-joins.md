# Walk record: invited-teammate-joins

- **Flow:** Invited teammate joins the workspace and sees the one step left
- **Value moment:** The teammate sees the workspace's domains and the one action left
- **Walked:** 2026-11-15 (date of the measurement; time not recorded)
- **Target:** http://127.0.0.1:8787 (local-copy)
- **Commit:** 6a7d775eb014bb5c314e70f0dad3455c47891df0
- **Kind:** baseline
- **Gate:** not run
- **Rules:** none

_Baseline transcribed from the 2026-11-15 measurement of `main` 6a7d775eb014bb5c314e70f0dad3455c47891df0 (one devbox, headless Chromium at 375x812 and 1440x900, local hosted instance with the repo's fakes: Turnstile test keys, the local mail log for codes, the Cloudflare API fake). It was not produced by `gate.mjs --record`. The next walk of this flow replaces it as the base `changed.sh` compares against._

### Measures

| Measure | Now |
|---|---|
| Owner: clicks and keystrokes to an invite link | 1 click, 25 keystrokes |
| Y of the invite link alert (375 / 1440) | 0.98 / 0.65 |
| Invitee: screens to value | 3 (accept, code, landing) |
| Invitee: clicks and keystrokes | 1 click, 21 + 6 keystrokes |
| Machine time, invitee | 3.2 s |

### Notes

- No invite email is sent; the owner passes the link on.
