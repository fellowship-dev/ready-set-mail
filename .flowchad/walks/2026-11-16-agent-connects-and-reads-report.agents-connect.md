# Walk record: agent-connects-and-reads-report

- **Flow:** An AI agent connects by MCP and reads its first email report
- **Value moment:** The agent receives its first useful report (get_email_report)
- **Walked:** 2026-11-16T15:36:43.521Z
- **Target:** https://127.0.0.1:8861 (local-copy)
- **Commit:** fe6784c6
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (1)

- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 8: decisions = 3, needs decisions <= 1

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 6 |  |
| `decisions_to_value` | — | 4 |  |
| `fields_to_value` | — | 2 |  |
| `clicks_to_value` | — | 6 |  |
| `words_to_value` | — | 1439 |  |
| `reading_time_to_value_s` | — | 363 |  |
| `non_task_elements_to_value` | — | 1 |  |
| `waits` | — | 0 |  |
| `longest_wait_ms` | — | 0 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 1917 |  |

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target

### Record notes (agents-connect)

- Walked at commit fe6784c6 on a local copy (https, self-signed, dynamic client registration on, no outbound mail). The "client" is a script: it reads the 401 challenge, registers, exchanges the code and calls whoami, list_domains and get_email_report (all three answered for the one domain); the callback page is stubbed. The walker found its first run failing FOLD-01 only because it measured a hidden mobile menu link and a page it had already left; the walker was corrected to measure the first control on the dashboard and the consent screen before the click. The first walk (at b6c17d3b) also showed the Agents page's first action (Copy URL) 1.6 screens down at 375, so the page was reordered (connect steps first, what an agent can do after) and walked again at fe6784c6.
- Measures at 375 and 1440 (identical): `scroll_before_primary_vh` 0 on every step that has an action, horizontal overflow 0. Consent (3 decisions: domains, permissions, end date) is the known DEC-01 rough edge, unchanged by this change. Words: consent 334, signed-out page 49, sign-in 23, Agents page 516 (after the value moment).
- `words_to_value` (1439) counts the one consent screen three times (choose domain, choose permissions, Allow access are three steps here); the earlier record (pr177b) sliced the same screen once, so the two totals are not comparable. Screens 6 (was 5: the signed-out page, sign-in, dashboard, consent, plus 2 non-browser steps), clicks 6, typed fields 2.
- Changed on this flow: the 401 challenge, discovery, the page for a link that cannot go on (signed in or out), the Agents page (per-assistant steps, what this instance supports), Settings → Agents list. The consent page's words are unchanged except "Settings, under Agents" and "Name it gives none" for an app that gave no name.
- Not walkable on a local copy: real Claude, ChatGPT, Cursor or VS Code; the client document path (covered in workerd tests with a mocked fetch).

- Words above the first action (measured on this walk's pages, same at both widths): consent 99 words above the first domain checkbox (its bottom 759 px of an 812 px screen at 375, 634 of 900 at 1440); Agents page 131 words above Copy URL (bottom 883 px at 375, 0.09 of a screen below the fold with this copy's setup-check banner on top, 604 of 900 at 1440; was 1305 px / 211 words before the reorder).
