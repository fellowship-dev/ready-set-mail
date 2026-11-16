# Walk record: agent-connects-and-reads-report

- **Flow:** An AI agent connects by MCP and reads its first email report
- **Value moment:** The agent receives its first useful report (get_email_report)
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
| Words on the consent page | 322 |
| Y of Allow access (375 / 1440) | 2.70 / 2.02 |
| Consent fields and checkboxes | 3 fields, 6 checkboxes |

### Notes

- Consent was measured on a separate HTTPS self-host instance: consent needs an HTTPS issuer.
