# Walk record: signup-to-records-live-cloudflare

- **Flow:** New hosted user signs up and gets DMARC with the report address live through Cloudflare
- **Value moment:** Records live - ownership proven and DMARC seen in public DNS, carrying the shared report address when the server admits the workspace to reports (HOSTED_CONNECT_REPORTS; by default only the operator's own workspaces)
- **Walked:** 2026-11-16T07:15:43.684Z
- **Target:** http://127.0.0.1:8860 (local-copy)
- **Commit:** 33f74b4943
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (7)

- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 2: S2 asks name, organization, whose email, and two optional answers: one group of profile answers plus the fork; step 2: decisions = 2, needs decisions <= 1
- **DEC-03** (should-fix) Derive instead of asking — step 2: optional "What is your role?" and "Where did you hear about us?" stay on S2 by the owner's explicit decision
- **ERR-02** (should-fix) Errors say what happened and how to fix it — step 1: the per-IP allowance of sign-up answers "Too many requests — try again later" with no time (one person in one sign-up does not meet it; the walk of ten sign-ups in minutes did); every other error says what happened and what to do (expired code: "That code has expired. Send a new code.", then S1 says the sign-up timed out and keeps the address)
- **ERR-03** (should-fix) Errors keep what was typed — step 2: what is typed on S2 and not yet sent is lost on a reload or when the sign-up times out (the address is kept; the password is [secret] by design); the typed domain and the checker domain are kept; a typo'd domain is corrected in place
- **NAV-02** (later) Every screen says where you are — step S2: S2 and S3 have no way back except "Start over" (which drops the attempt); the browser Back button works
- **NOISE-01** (should-fix) Everything visible serves the step — step 8: step 2: the two optional fields (owner decision); step 4: the "What happens next" aside at 1440 (the use of the wide screen the owner asked for; hidden at 375); step 8: Export PDF and Add domain in the page header; S4 and C2: the hand-off link
- **PATH-03** (should-fix) Every step earns its place — step 2: optional "What is your role?" and "Where did you hear about us?" stay on S2 by the owner's explicit decision; every other screen collects what the value needs or delivers part of it (consent and the C2 review are the "you see every record before it is written" promise)

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 7 |  |
| `decisions_to_value` | — | 8 |  |
| `fields_to_value` | — | 6 |  |
| `clicks_to_value` | — | 7 |  |
| `words_to_value` | — | 558 |  |
| `reading_time_to_value_s` | — | 141 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 9 |  |
| `waits` | — | 3 |  |
| `longest_wait_ms` | — | 1833 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 22018 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- Where this local copy differs from production (read every finding with this in mind): a throwaway hosted instance on the devbox (wrangler dev --local, MODE=saas, SAAS_ENABLED=1, a fresh local D1) over plain http on 127.0.0.1, built from this commit, not a deployed target; product analytics OFF (no POSTHOG settings); Turnstile runs with Cloudflare's documented always-pass test keys (the widget loads from its real host and issues a dummy token; it never asked for a click); the sign-in code mail is captured in the Worker log (local send_email simulation) and read from there; the Cloudflare API and DNS-over-HTTPS are the in-memory fakes of the repo (e2e/support/fake-cloudflare.mjs); nothing reaches api.cloudflare.com; INTAKE_DOMAIN and HOSTED_CONNECT_REPORTS=all are set so the shared report address is written (the production default, owner, admits only the operator's own workspaces); Cloudflare's consent screen is a local stand-in page (Allow / Cancel, on 127.0.0.1, standing for dash.cloudflare.com) and the OAuth token [secret] is a local stub; the Worker's own redirect, state check, code exchange, connection and import after the return are the real code; the first read of public DNS (the S4 line, the first check the dashboard repeats) goes through the fake DoH and is real code; the domain page and the daily refresh read the real public DNS, where the made-up names do not exist: the browser answers the setup status and the other domains' check summaries as resolving names, the domain being set up is left as the Worker read it.
- File name: the 2026-11-16 record of this flow (PR 178) is already in the base commit, and a record that edits it would not count as added; this one is named 2026-11-17 for that reason only. The Walked line above is the real time of this walk.
- Also walked, from the website checker (?domain=brightwave-mail.com): 6 product screens + 1 consent, 5 typed fields, 82 keystrokes, 6 clicks, 502 words at 1440 / 502 at 375, farthest action bottom at 375 0.96 vh. S4 checks the carried domain on arrival (no field, no Check click) and names it with "Not this domain?".
- Also walked, agency fork ("My clients'", organization Northside IT, first client brightwave-mail.com): 6 product screens + 1 consent, 6 typed fields, 87 keystrokes, 7 clicks, 528 words at 1440 / 489 at 375, farthest action bottom at 375 0.94 vh. Workspaces before S4: [{"name":"Default"},{"name":"New client"}]; after the client's domain: [{"name":"Default"},{"name":"brightwave-mail.com"}]; only the client's zone was imported ([{"domain":"brightwave-mail.com","ws":"brightwave-mail.com"}]); C2 says "Not added: this workspace is for brightwave-mail.com. Add each client from Add domain, in its own workspace."
- This walk (cold, "My company's"): 6 product screens + 1 consent, 6 typed fields, 101 keystrokes, 7 clicks, 558 words at 1440 / 519 at 375, farthest action bottom at 375 0.96 vh; time to value 22 s scripted. Screens: S1, S2, S3, S4, Cloudflare consent (not ours), C2, D1. The Cloudflare consent screen is the one screen that is not ours.
- Against the reviewer's walk of PR 177 at 8a8c35b (7 screens plus consent, about 101 keystrokes, 7 clicks, about 480 words): the interstitial "Connect Cloudflare" page and the token paste are gone, step counters are gone, and the first-day card is first on the page; keystrokes and clicks are the same as the reviewer's count because every typed answer is the owner's choice (email, password, name, organization, domain, code) and the clicks are Continue, the fork card, Continue, Check, Connect Cloudflare, Allow (Cloudflare's own screen) and Apply.
- Unhappy paths walked at 375 (dead_ends): wrong-code: recovers; expired-code: recovers; start-over: recovers; s2-code-expired-while-typing: recovers; close-tab-at-S2-return-to-root: recovers; already-registered: recovers; typo-domain: recovers; consent-cancelled: recovers; reload-and-back: recovers.
- Not walkable on a local copy: Cloudflare's real consent screen and real OAuth; the real public DNS for the made-up names (so the domain page of a resolving domain and the daily refresh are not seen); production Turnstile that asks for a click; real mail delivery and a real inbox; the live HOSTED_CONNECT_REPORTS=owner setting (here all, so the report address is written).
- The first-day card flipped to "first reports are on their way" 55 s after Apply, by itself (first-check at s=-6, 10, 25, 40, 55); the first read of public DNS is reused for up to a minute, so the flip needs the next look after that.

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
