# Walk record: agent-connects-and-reads-report

- **Flow:** An AI agent connects by MCP and reads its first email report
- **Value moment:** The agent receives its first useful report (get_email_report)
- **Walked:** 2026-11-16T18:48:36.130Z
- **Target:** https://127.0.0.1:8871 (local-copy)
- **Commit:** 1b2edb5
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (2)

- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 8: decisions = 3, needs decisions <= 1
- **NOISE-01** (should-fix) Everything visible serves the step — step 7 @375: the "Also allow one domain that is not added yet" block with a Workspace select and a Domain field sits between the domain choice and the permissions for a person who only wants to read a report

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 6 |  |
| `decisions_to_value` | — | 4 |  |
| `fields_to_value` | — | 3 |  |
| `clicks_to_value` | — | 6 |  |
| `words_to_value` | — | 1201 |  |
| `reading_time_to_value_s` | — | 303 |  |
| `non_task_elements_to_value` | — | 1 |  |
| `waits` | — | 2 |  |
| `longest_wait_ms` | — | 2213 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 6709 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- The sign-in step makes the person wait for a bot check before the button works; on this copy the check is a test key and passes in about 2 s, on the real service the time is not measured here

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target

### Record notes (resume)

- Walked at commit 1b2edb5 (HEAD, no uncommitted change to a covered file) on a throwaway local hosted copy: the Worker in hosted mode (`MODE=saas`) over https with a self-signed certificate, dynamic client registration on (`MCP_DCR_ENABLED=1`), the bot check on Cloudflare's always-pass test keys, mail captured in the Worker log (the sign-in code was read from it), a fake Cloudflare and DNS-over-HTTPS, the one domain proven by a TXT record in the fake. Fresh Chromium with the write guard installed (`serviceWorkers: 'block'`), 1440x900 and 375x812 at every step; the agent side is a script (discovery from the 401, registration, PKCE, token, `/mcp`); the client.example callback is stubbed. The account existed before the walk (signed out when it started), as the flow's context says.
- What changed on this flow since the previous record (c8a04043): the consent page leads with who is verifiable (the address the app sends the person back to, "Allow the app at client.example to work with your domains?", with "Not verified" and "It gave no name.") and never with the name the app chose; its action bar (Allow access, Don't allow) is sticky at the bottom of the screen; signing in on the way carries the request through (`?continue=`), so the person lands on the consent page and not the dashboard (the previous walk went sign-in, dashboard, consent); registration is switched on for the hosted service and the registered name is not kept (the registration answer has no `client_name`, although "Claude" was sent).
- Path walked (12 steps): /llms.txt (200, names the MCP endpoint); POST /mcp 401 with the metadata address; registration 201 without a name; signed-out authorize page ("Sign in to continue", "Sign in and continue", a link styled as a button; the answer is HTTP 401, one console line); the dashboard's sign-in form; password, then the emailed 6-digit code; back on the consent page (heading as above, "Not verified: nobody has checked who this app is.", "It gave no name.", 0 boxes ticked, path /oauth/authorize); domain and two read permissions ticked; Allow access (back to the app with code, state and iss); token, whoami (grants the domain, resources:read, reports:read, ends in 7 days), list_domains (1 domain), get_email_report (first value: "Email health for harbor-lane.org: 2 configuration findings ... DMARC next step: Publish a DMARC record at p=none.", grade Unprotected, which matches the public DNS: no SPF, no DMARC).
- Measures, identical at 375 and 1440 unless two numbers are given. Words on the consent page: 307 in `main` (heading, 4 trust lines, domains, optional new-domain block, 6 permissions, end date, what it can never do, 2 buttons). Words above the primary action (Allow access): 303 (every word of the page except the two buttons, because the bar comes last in reading order; it stays on screen). Words above the first domain checkbox: 77 (bottom at 679 px of 812 at 375, 598 px of 900 at 1440). Allow access button, top and bottom: at 375x812, at the top of the page 756 to 800 px, scrolled halfway (785 px) 756 to 800, scrolled to the end (1570 px) 690.5 to 734.5; at 1440x900, top of the page 844 to 888, halfway (578 px) 844 to 888, end (1155 px) 778.8 to 822.8. All inside the viewport (button height 44), `position: sticky`; page height 2382 px at 375 and 2055 px at 1440. Horizontal overflow 0 at both widths on every screen. `scroll_before_primary_vh` 0 at both widths on every screen with an action (steps 4 to 9); no scroll measure on the plain-text page or the script steps (no input there), so the gate's FOLD-01 reads steps 4 to 9 and the walker's judgement.
- Effort to value: 6 screens by the gate's count (/llms.txt, the agent client, signed-out page, sign-in, code, consent; the person sees 4), 6 clicks, 3 typed fields (email, password, code; hosted sign-in asks for the code), 4 decisions (sign-in 1, consent 3: domains, permissions, end date; the end date has a default, so 2 if a prefilled answer is not counted), time to value 6.7 s of walking. `words_to_value` (1201) counts the one consent screen three times (steps 7 to 9) and the llms.txt text, so it is not comparable with the previous 1439; non-task elements are counted once for the consent screen (1: the optional "Also allow one domain that is not added yet" block with its Workspace select and Domain field).
- FOLD rules: FOLD-01 (blocker) passes at both widths on steps 4 to 9 (measured). The gate applies FOLD-01 only; FOLD-02 to FOLD-04 were not judged separately here beyond overflow 0 and one dominant action (Allow access filled, Don't allow outlined) on the consent page.
- Known rough edges carried: DEC-01 (consent asks 3 things on one screen, unchanged), NOISE-01 (the optional new-domain block with a Workspace select that says "Choose a workspace" sits between the domain choice and the permissions).
- Dead ends tried (all recoverable): an authorization code used twice (400 invalid_grant, "Authorization code already used", the app starts over); the same authorize link opened again after approval (consent page again, nothing ticked, so a reused link asks again and never silently grants); a link from an unknown app, signed in and signed out (400, "Ready Set Mail doesn't recognise this app", an Open Agents link); a redirect address the app did not register (400, "This app asked to send you somewhere it did not register", nothing shared, stays on our origin); a consent page opened earlier and submitted after the app already had its token (a second, separate approval and code; the first is unaffected); Allow access with nothing ticked ("Check your choices", "Choose at least one thing the app may do.", "Nothing was shared. Use your browser's back button ...": Back returns to the form with nothing ticked); Don't allow (the app is sent back with error=access_denied). The gate's WAIT-01 reads wait_feedback true at step 6 (the click waits about 2 s for the bot check and the page says "Waiting for the human check..." meanwhile; the code screen follows the click in about 0.15 s) and at step 12 (get_email_report took 2.2 s for live DNS checks; a script has no screen, the agent's client shows the call in progress, this was judged and not measured).
- Console and network on the way: signed-out authorize page and the first session check answer 401 by design (two console lines, nothing on screen); an aborted widget request to the bot-check host on the code screen (test keys); the callback host is stubbed (the guard never saw it).
- Not walkable on a local copy: real Claude, ChatGPT, Cursor or VS Code driving the flow; clients that publish a client document (covered in workerd tests with a mocked fetch); the real mail path, the real bot check, a real certificate; consent with more than one workspace or several domains.
- Screenshots: 375 px PNGs of the browser steps, the consent page (top, scrolled halfway with the bar, and with the choices made) and two dead ends are under .flowchad/walks/resume/agent-connects-and-reads-report/ (01 llms.txt, 04 signed-out page, 05 sign-in, 06 code, 07 lands on consent, 08 choices, 09 Allow access, consent-top, consent-scrolled-mid, consent-chosen-scrolled-mid, dead-end-reused-link, dead-end-unknown-app); the 1440 px captures stay out of the repository.
