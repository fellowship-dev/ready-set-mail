# Walk record: signup-to-records-live-cloudflare

- **Flow:** New hosted user signs up and gets DMARC with the report address live through Cloudflare
- **Value moment:** Records live - ownership proven and DMARC seen in public DNS, carrying the shared report address when the server admits the workspace to reports (HOSTED_CONNECT_REPORTS; by default only the operator's own workspaces)
- **Walked:** 2026-11-16T12:25:49.797Z
- **Target:** http://127.0.0.1:8860 (local-copy)
- **Commit:** 5a5caed85b
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (5)

- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 2: S2 asks name, organization, whose email, and two optional answers: one group of profile answers plus the fork; step 2: decisions = 2, needs decisions <= 1
- **DEC-03** (should-fix) Derive instead of asking — step 2: optional "What is your role?" and "Where did you hear about us?" stay on S2 by the owner's explicit decision
- **NAV-02** (later) Every screen says where you are — step S2: S2 and S3 have no way back except "Start over" (which drops the attempt); the browser Back button works
- **NOISE-01** (should-fix) Everything visible serves the step — step 8: step 2: the two optional fields (owner decision); step 8: Export PDF and Add domain in the page header; S4 and C2: the hand-off link
- **PATH-03** (should-fix) Every step earns its place — step 2: optional "What is your role?" and "Where did you hear about us?" stay on S2 by the owner's explicit decision; every other screen collects what the value needs or delivers part of it (consent and the C2 review are the "you see every record before it is written" promise)

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 7 |  |
| `decisions_to_value` | — | 8 |  |
| `fields_to_value` | — | 6 |  |
| `clicks_to_value` | — | 7 |  |
| `words_to_value` | — | 486 |  |
| `reading_time_to_value_s` | — | 123 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 8 |  |
| `waits` | — | 3 |  |
| `longest_wait_ms` | — | 1834 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 20727 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- This walk (cold, "My company's"): 6 product screens + 1 consent, 6 typed fields, 101 keystrokes, 7 clicks, 486 words at 1440 / 458 at 375, farthest action bottom at 375 n/a vh; time to value 21 s scripted. Screens: S1, S2, S3, S4, Cloudflare consent (not ours), C2, D1. The Cloudflare consent screen is the one screen that is not ours.
- Against the reviewer's walk of PR 177 at 8a8c35b (7 screens plus consent, about 101 keystrokes, 7 clicks, about 480 words): the interstitial "Connect Cloudflare" page and the token paste are gone, step counters are gone, and the first-day card is first on the page; keystrokes and clicks are unchanged because every typed answer is the owner's choice (email, password, name, organization, domain, code) and the three clicks of S1, S2 and the Check button remain.
- Unhappy paths walked at 375 (dead_ends): wrong-code: recovers; already-registered: recovers; expired-code: recovers; start-over: recovers; s2-code-expired-while-typing: recovers; close-tab-at-S2-return-to-root: recovers; typo-domain: recovers; consent-cancelled: recovers; reload-and-back: recovers.
- Not walkable on a local copy: Cloudflare's real consent screen and real OAuth; the real public DNS for the made-up names (so the domain page of a resolving domain and the daily refresh are not seen); production Turnstile that asks for a click; real mail delivery and a real inbox; the live HOSTED_CONNECT_REPORTS=owner setting (here all, so the report address is written).
- The first-day card flipped to "first reports are on their way" 61 s after Apply, by itself (first-check at s=0, 15, 30, 45, 60); the first read of public DNS is reused for up to a minute, so the flip needs the next look after that.

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target

### Record notes (this pull request)

- Record names: this record is <walked date>-<id>.pr177b.md (round 3 of PR 177), replacing the pr177 record of the same flow. It was walked at commit 5a5caed85b on the branch after merging main at db916a9; no file the flow covers changes between that commit and the records commit (scripts/check-flows.mjs).
- This walk: a new hosted account, "My company's", Cloudflare path (fake Cloudflare, local OAuth stand-in): S1, S2, S3, S4, Cloudflare's consent, C2 review, Apply, the first-day card; the card flipped to "first reports are on their way" by itself once public DNS (the fake DoH) showed the record. Unhappy paths walked at 375 on two instances (the per-IP sign-up allowance is 10 an hour): wrong code, already-registered address, expired code (Send a new code returns to S1, which says the sign-up timed out and keeps the address), start over, S2 timeout, closed tab, typo domains, cancelled consent, reload and Back; all recover.
- Screenshots: 375 px PNGs of every step are committed under .flowchad/walks/pr177b/signup-to-records-live-cloudflare/; the 1440 px captures (measured the same way, see the measures above, which cover both widths) and dark captures stay in the walk's out-of-repo evidence folder.

### Screenshots (375 px, light, one per step)

- step 1 `S1-signup`: `.flowchad/walks/pr177b/signup-to-records-live-cloudflare/01-S1-signup@375.png`
- step 2 `S2-about`: `.flowchad/walks/pr177b/signup-to-records-live-cloudflare/02-S2-about@375.png`
- step 3 `S3-code`: `.flowchad/walks/pr177b/signup-to-records-live-cloudflare/03-S3-code@375.png`
- step 4 `S4-domain-empty`: `.flowchad/walks/pr177b/signup-to-records-live-cloudflare/04-S4-domain-empty@375.png`
- step 5 `S4-result-cloudflare`: `.flowchad/walks/pr177b/signup-to-records-live-cloudflare/05-S4-result-cloudflare@375.png`
- step 6 `CF-consent`: `.flowchad/walks/pr177b/signup-to-records-live-cloudflare/06-CF-consent@375.png`
- step 7 `C2-review`: `.flowchad/walks/pr177b/signup-to-records-live-cloudflare/07-C2-review@375.png`
- step 8 `D1-after-apply`: `.flowchad/walks/pr177b/signup-to-records-live-cloudflare/08-D1-after-apply@375.png`
- step 9 `D1-live`: `.flowchad/walks/pr177b/signup-to-records-live-cloudflare/09-D1-live@375.png`
- step 10 `D1-reload`: `.flowchad/walks/pr177b/signup-to-records-live-cloudflare/10-D1-reload@375.png`
