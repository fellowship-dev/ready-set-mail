# Walk record: signup-to-records-live-manual

- **Flow:** New hosted user signs up and gets DMARC with the report address live by adding records by hand
- **Value moment:** Records live - ownership proven by the TXT record and DMARC seen in public DNS, carrying the shared report address when the server admits the workspace to reports (HOSTED_CONNECT_REPORTS; by default only the operator's own workspaces)
- **Walked:** 2026-11-16T13:31:20.085+00:00
- **Target:** http://127.0.0.1:8841 (local-copy)
- **Commit:** 04e269bca2e98f1c731f4387f9dff3d122b6dcde
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (0)

- none found by the rules

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 6 |  |
| `decisions_to_value` | — | 6 |  |
| `fields_to_value` | — | 4 |  |
| `clicks_to_value` | — | 4 |  |
| `words_to_value` | — | 493 |  |
| `reading_time_to_value_s` | — | 124 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 4 |  |
| `waits` | — | 0 |  |
| `longest_wait_ms` | — | 802 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 12163 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- After the DMARC record was published at the DNS host and the person came back to the DMARC step with the browser back button, the step kept saying "No DMARC record found" and offering the record to publish until the page was reloaded; after a reload it said "Your DMARC record is published, read from public DNS". There is no Check again control on that step. Same family as the WORD-05 override of this flow (a panel that does not refresh), found outside the changed lines.
- Walk surface: see surface.differences_from_production in the walk (stubbed bot check, fake Cloudflare and DNS answers, made-up domain); the screens, copy and measures are the product's own.

### Notes

- override for FOLD-01 not used: the rule did not fail
- override for WORD-05 not used: the rule did not fail
- staleness not checked: no deploy time given and no deploy check configured for the target
