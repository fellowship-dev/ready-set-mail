# Walk record: signup-to-records-live-manual

- **Flow:** New hosted user signs up and gets DMARC with the report address live by adding records by hand
- **Value moment:** Records live - ownership proven by the TXT record and DMARC seen in public DNS, carrying the shared report address when the server admits the workspace to reports (HOSTED_CONNECT_REPORTS; by default only the operator's own workspaces)
- **Walked:** 2026-11-16T21:31:53.012Z
- **Target:** http://127.0.0.1:8871 (local-copy)
- **Commit:** 33b0f64e96
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (6)

- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 2: decisions = 2, needs decisions <= 1
- **DEC-03** (should-fix) Derive instead of asking — step 2: optional "What is your role?" and "Where did you hear about us?" stay on S2 by the owner's explicit decision
- **NAV-02** (later) Every screen says where you are — step 2: S2 and S3 have no way back except "Start over" (which drops the attempt); the browser Back button works
- **NOISE-01** (should-fix) Everything visible serves the step — step 5: step 2: the two optional fields (owner decision); step 5: Export PDF and Add domain in the page header; S4: the hand-off link
- **PATH-03** (should-fix) Every step earns its place — step 2: optional "What is your role?" and "Where did you hear about us?" stay on S2 by the owner's explicit decision
- **WORD-04** (should-fix) One name for one thing — step 5: after the value step the DMARC step (opened by its address): "1 of 4 steps complete", "Skip setup", "Step 2 of 4: SPF"

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 5 |  |
| `decisions_to_value` | — | 5 |  |
| `fields_to_value` | — | 5 |  |
| `clicks_to_value` | — | 3 |  |
| `words_to_value` | — | 334 |  |
| `reading_time_to_value_s` | — | 84 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 5 |  |
| `waits` | — | 2 |  |
| `longest_wait_ms` | — | 14364 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 23594 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- Checker-link variants at 375 (fresh browser each, nothing signed in): no domain: Check and fix your domain's SPF, DKIM and DMARC. (overflow 0px); not a domain: Check and fix your domain's SPF, DKIM and DMARC. (overflow 0px); long: You're setting up mail-security-reporting-for-the-harbor-lane-association.co.uk. (overflow 0px); capitals: You're setting up harbor-lane.org. (overflow 0px); 63-char label: You're setting up [a x63].example.org. (overflow 0px).
- After the value step: DMARC record added at the DNS host is not walkable locally; card flipped to "first reports": false after 60s.
- The domain page of a resolving domain is not walkable locally (public DNS does not know the made-up name); the DMARC step was opened by its address.
- Turnstile: the browser's request to challenges.cloudflare.com for the always-pass test widget may end net::ERR_ABORTED (guarded browser); sign-up still goes through with the test keys.

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target

### Record notes (this pull request)

- Record names: this record is <walked date>-<id>.checker-s1-r2.md. It replaces the checker-s1 record of the same flow (walked at ea024c9b13), which CI rejected because files this flow covers changed in main after that commit (PR 183, "Connect reports in one step"). Walked at commit 33b0f64e96, the head of fix/signup-names-checker-domain after merging main db9527e (PR 183); no file the flow covers changes between that commit and the records commit (scripts/check-flows.mjs).
- The change under walk: the sign-up from the website checker's link, `#/signup?domain=harbor-lane.org&src=report`. S1 says "You're setting up harbor-lane.org." and asks for no domain; S4 opened on "Domain: harbor-lane.org · Not this domain?" with the domain prefilled and never typed (the domain field, its Check click and the empty S4 screen of pr177b are gone).
- This walk: a new hosted account on a local copy built from that commit (fake DoH and fake Cloudflare, test keys, captured mail), "My company's", manual path, a GoDaddy-hosted name; the TXT proof record was added by the walker at the fake DNS host and found by the 15-second poll; 5 steps, value step 5. Walked twice at both widths (once with the window starting at 1440x900 and once at 375x812; each step captured at both widths in the same session): both runs gave the same measures apart from timings, gate PASS with no overrides on both. The gate record above is the 1440-first run (the 375-first run did not open the older DMARC step, so it lists 5 rough edges, without WORD-04).
- S1 at 375, exactly as the person reads it: "Create your account" / "You're setting up harbor-lane.org." / "Work email" / "Password" / "Show" / "At least 8 characters." / "Continue" / "By creating an account you agree to the Terms and the Privacy Policy." / "Already have an account? Sign in" / "Terms" / "Privacy". S4 showed "Domain: harbor-lane.org · Not this domain?" with the domain untyped.
- Against the checker-s1 record of this flow (walked at ea024c9b13; same counting rules):

| Measure | checker-s1 | Now (r2) | Change |
|---|---|---|---|
| `screens_to_value` | 5 | 5 | +0 |
| `decisions_to_value` | 5 | 5 | +0 |
| `fields_to_value` | 5 | 5 | +0 |
| `clicks_to_value` | 3 | 3 | +0 |
| `words_to_value` at 1440 | 323 | 334 | +11 (step 5: the first-day card's explanation now reads "The domain page has Connect reports, which shows the exact record to add once the domain is connected." (PR 183, web/src/components/FirstDay.tsx), +11 words) |
| `words_to_value` at 375 | 323 | 334 | +11 (the same +11) |
| `reading_time_to_value_s` | 81 | 84 | +3 |
| `max_scroll_before_primary_vh` | 375: 0 · 1440: 0 | 375: 0 · 1440: 0 | none |
| `non_task_elements_to_value` | 5 | 5 | +0 |
| `waits` | 2 | 2 | +0 |
| `longest_wait_ms` | 14881 | 14364 | -517 |
| `dead_ends` / `loops` | 0 / 0 | 0 / 0 | none |
| `time_to_value_ms` (scripted) | 21277 | 23594 | +2317 (a timing of the script, not of the product: this walk pauses 0.4 s per step before it captures, and the polls land at different moments) |

  fields_to_value does not grow. The longest wait is the TXT proof record being found by the 15-second poll (about 14 s after the walker added it at the fake DNS host); the screen says "Waiting for verification" and "We look for it ourselves every 15 seconds" while it waits. The clicks include the tap on "My company's" on S2 (a radio card, not preselected), counted on the screen that follows.
- Per step, at 375 / 1440: words above the action (counted here as the words of the main content that precede the action's own label, the options of the optional select left out, so a difference of one or two from the checker-s1 record's counts is the counting), where the action's bottom sits (in screens, 1 = the bottom of the first screen) and the scroll before the first input (FOLD-01); the action is the one named in its column:

| Step | Screen | Action | Words | Words above the action | Action bottom (screens) | Scroll before first input |
|---|---|---|---|---|---|---|
| 1 | S1 | Continue | 37 | 15 / 15 | 0.53 / 0.63 | 0 / 0 |
| 2 | S2 | Continue | 67 | 47 / 47 | 0.94 / 0.86 | 0 / 0 |
| 3 | S3 | Continue | 28 | 17 / 17 | 0.42 / 0.6 | 0 / 0 |
| 4 | S4 | Verify | 84 | 53 / 53 | 0.74 / 0.53 | 0 / 0 |
| 5 | first-day | See what to add | 118 | 55 / 55 | 0.6 / 0.41 | 0 / 0 |

- Checker-link variants at 375, fresh browser each: no domain -> Check and fix your domain's SPF, DKIM and DMARC. (overflow 0 px); not a domain -> Check and fix your domain's SPF, DKIM and DMARC. (overflow 0 px); long -> You're setting up mail-security-reporting-for-the-harbor-lane-association.co.uk. (overflow 0 px); capitals -> You're setting up harbor-lane.org. (overflow 0 px); 63-char label -> You're setting up [a x63].example.org. (overflow 0 px). A link with no or a non-domain value falls back to the generic line; nothing from the link is injected as markup.
- The card did not flip to "first reports are on their way" (waited 60 s, then reloaded): the domain page and daily refresh read real public DNS, where harbor-lane.org does not exist (surface limit, as in pr177b and checker-s1). The older DMARC step, opened by its address (`#/domains/<id>/setup/dmarc`), still says "1 of 4 steps complete", "Step 2 of 4: SPF" and "Skip setup" (WORD-04).
- Tooling note: `/flow-gate` as written picks `.claude/skills/flow-gate/scripts/gate.mjs` first, a symlink that prints and writes nothing; the gate was run from `.agents/skills/flow-gate/scripts/gate.mjs`, recording to a scratch folder and copying the record into place (`--record .flowchad/walks` would have overwritten the older `2026-11-16-signup-to-records-live-manual.md`).
- Screenshots: 375 px PNGs of every step are committed under .flowchad/walks/checker-s1-r2/signup-to-records-live-manual/; the 1440 px captures (measured the same way) stay in the walk's out-of-repo evidence folder.

### Screenshots (375 px, light, one per step)

- step 1 `S1-signup`: `.flowchad/walks/checker-s1-r2/signup-to-records-live-manual/01-S1-signup@375.png`
- step 2 `S2-about`: `.flowchad/walks/checker-s1-r2/signup-to-records-live-manual/02-S2-about@375.png`
- step 3 `S3-code`: `.flowchad/walks/checker-s1-r2/signup-to-records-live-manual/03-S3-code@375.png`
- step 4 `S4-prefilled-records`: `.flowchad/walks/checker-s1-r2/signup-to-records-live-manual/04-S4-prefilled-records@375.png`
- step 5 `after-proof`: `.flowchad/walks/checker-s1-r2/signup-to-records-live-manual/05-after-proof@375.png`
