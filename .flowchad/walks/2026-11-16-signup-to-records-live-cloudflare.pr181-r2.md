# Walk record: signup-to-records-live-cloudflare

- **Flow:** New hosted user signs up and gets DMARC with the report address live through Cloudflare
- **Value moment:** Records live - ownership proven and DMARC seen in public DNS, carrying the shared report address when the server admits the workspace to reports (HOSTED_CONNECT_REPORTS; by default only the operator's own workspaces)
- **Walked:** 2026-11-16T16:26:23+00:00
- **Target:** http://127.0.0.1:8851 (local-copy)
- **Commit:** c1069a7ec60c66e305b4fd0740c252180450c050
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (2)

- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 2: decisions = 2, needs decisions <= 1; step 3: decisions = 3, needs decisions <= 1
- **NOISE-04** (should-fix) No welcome copy, tours or instructions to read first — step 4 @1440: S4 at 1440 shows a "What happens next" panel (three sentences) that restates "Looking it up changes nothing in its DNS" and the next screens

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 7 |  |
| `decisions_to_value` | — | 11 |  |
| `fields_to_value` | — | 7 |  |
| `clicks_to_value` | — | 7 |  |
| `words_to_value` | — | 575 |  |
| `reading_time_to_value_s` | — | 145 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 4 |  |
| `waits` | — | 1 |  |
| `longest_wait_ms` | — | 1774 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 14540 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- Intermittent, seen in 2 of 3 earlier trial runs of the same dead end and not in the final walk: after six wrong sign-in codes and "Send a new code", typing the new code showed "Too many requests — try again later" beside "A new code is on its way" (no time to wait given; the sign-in limiter and the code messages disagree)
- The first load of the sign-up page logs a 401 from the signed-out session probe (GET /api/me) as a console error; harmless to the person but noisy in every walk
- On the first dashboard after Apply, every imported domain is listed with its own state; two domains the person did not choose to work on appear above and below the one they just fixed (in this copy one is flagged "Needs attention" only because the fake zone names do not exist in public DNS)

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
