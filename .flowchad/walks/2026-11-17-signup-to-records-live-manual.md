# Walk record: signup-to-records-live-manual

- **Flow:** New hosted user signs up and gets DMARC with the report address live by adding records by hand
- **Value moment:** Records live - ownership proven by the TXT record and DMARC seen in public DNS, carrying the shared report address when the server admits the workspace to reports (HOSTED_CONNECT_REPORTS; by default only the operator's own workspaces)
- **Walked:** 2026-11-16T07:20:08.974Z
- **Target:** http://127.0.0.1:8863 (local-copy)
- **Commit:** 33f74b4943
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (8)

- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 2: S2 asks name, organization, whose email and two optional answers; step 2: decisions = 2, needs decisions <= 1
- **DEC-03** (should-fix) Derive instead of asking — step 2: optional "What is your role?" and "Where did you hear about us?" stay on S2 by the owner's explicit decision
- **ERR-02** (should-fix) Errors say what happened and how to fix it — step 1: the per-IP allowance of sign-up answers "Too many requests — try again later" with no time (the sign-up screens are the same as on the Cloudflare path)
- **ERR-03** (should-fix) Errors keep what was typed — step 2: what is typed on S2 and not yet sent is lost on a reload or when the sign-up times out (the address is kept; the password is [secret] by design)
- **NAV-02** (later) Every screen says where you are — step S2: S2 and S3 have no way back except "Start over" (which drops the attempt); the browser Back button works
- **NOISE-01** (should-fix) Everything visible serves the step — step 6: step 2: the two optional fields (owner decision); step 4: the "What happens next" aside at 1440; step 6: Export PDF and Add domain in the header
- **PATH-03** (should-fix) Every step earns its place — step 2: optional "What is your role?" and "Where did you hear about us?" stay on S2 by the owner's explicit decision
- **WORD-04** (should-fix) One name for one thing — step 8: after the value step the DMARC step is the older setup wizard ("Step 4 of 4", "1 of 4 steps complete", "Skip setup"): its counter does not match the first run's no-counter wording; slice 2 replaces it (G1)

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 5 |  |
| `decisions_to_value` | — | 6 |  |
| `fields_to_value` | — | 6 |  |
| `clicks_to_value` | — | 7 |  |
| `words_to_value` | — | 386 |  |
| `reading_time_to_value_s` | — | 97 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 9 |  |
| `waits` | — | 3 |  |
| `longest_wait_ms` | — | 13062 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 78357 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- Where this local copy differs from production (read every finding with this in mind): a throwaway hosted instance on the devbox (wrangler dev --local, MODE=saas, SAAS_ENABLED=1, a fresh local D1) over plain http on 127.0.0.1, built from this commit, not a deployed target; product analytics OFF (no POSTHOG settings); Turnstile runs with Cloudflare's documented always-pass test keys (the widget loads from its real host and issues a dummy token; it never asked for a click); the sign-in code mail is captured in the Worker log (local send_email simulation) and read from there; the Cloudflare API and DNS-over-HTTPS are the in-memory fakes of the repo (e2e/support/fake-cloudflare.mjs); nothing reaches api.cloudflare.com; INTAKE_DOMAIN and HOSTED_CONNECT_REPORTS=all are set so the shared report address is written (the production default, owner, admits only the operator's own workspaces); Cloudflare's consent screen is a local stand-in page (Allow / Cancel, on 127.0.0.1, standing for dash.cloudflare.com) and the OAuth token [secret] is a local stub; the Worker's own redirect, state check, code exchange, connection and import after the return are the real code; the first read of public DNS (the S4 line, the first check the dashboard repeats) goes through the fake DoH and is real code; the domain page and the daily refresh read the real public DNS, where the made-up names do not exist: the browser answers the setup status and the other domains' check summaries as resolving names, the domain being set up is left as the Worker read it; the person's DNS host ("GoDaddy" for harbor-lane.org) is the Cloudflare fake's zone: the walker added each record there as a person pastes it at a DNS host.
- File name: the 2026-11-16 record of this flow (PR 178) is already in the base commit, and a record that edits it would not count as added; this one is named 2026-11-17 for that reason only. The Walked line above is the real time of this walk. The value step of this walk is the one the flow file marks (the proof record found by itself, and the card saying what comes next with the way to add it); the steps after it are walked and measured but come after the value step.
- This walk (manual, a GoDaddy-hosted name) to the value step: 5 product screens, 6 typed fields, 82 keystrokes, 7 clicks, 386 words at 1440 / 347 at 375, farthest action bottom at 375 0.94 vh; to "records live" through the older DMARC step: 8 product screens, 6 typed fields, 82 keystrokes, 10 clicks, 1085 words at 1440 / 1036 at 375, farthest action bottom at 375 2.28 vh (the domain page, "See what to add", is not walkable here: see below, so the older DMARC step opened by its address stands in for it).
- Unreachable locally: the domain page of a resolving domain (D2). It, the daily refresh and the check summaries read the real public DNS, where harbor-lane.org does not exist, so it says "Check the spelling, or remove this domain"; the walker opened the DMARC step by its address, as e2e/cloudflare-first-run.spec.ts does. The article "How to add a TXT record at GoDaddy", the paste at a real DNS host and real propagation delay are outside a local copy.
- The first reads of public DNS go through the fake DoH (real code): the card flipped 31 s after the DMARC record was added, by itself.
- The manual path deliberately keeps the older screens after the proof (G1 all-records list with provider quirks, G2 share page, U1 are slice 2).

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
