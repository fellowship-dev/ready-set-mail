# Product analytics (hosted dashboard, PostHog)

Internal. How the hosted dashboard counts the steps people take, so the funnels show where each account stops: sign-up and onboarding to records live and the first report, domain configuration, and the path to a paid fix.

**Off by default.** Nothing is sent unless the Worker runs with `MODE=saas` **and** both `POSTHOG_KEY` (a `phc_` project key) and `POSTHOG_HOST` (exactly `https://us.i.posthog.com` or `https://eu.i.posthog.com`) are set. A self-hosted installation never sends anything, whatever it sets; `npm run setup` sets neither variable, and `MODE=saas` alone does not turn it on. The opt-in self-host telemetry that used to exist (`src/telemetry.ts`, the "Share anonymous usage stats" checkbox) is removed: its endpoint never resolved, so it never sent anything either.

Code: `src/product-analytics/` (`events.ts` the allow-list, `capture.ts` the sender, `identity.ts` the id, `auth.ts` and `steps.ts` the hooks). Tests: `test/product-analytics/`, `test/scripts/posthog-setup.test.ts`, `e2e/product-analytics.spec.ts`.

## How an event is sent

- **Server-side only, from the Worker.** The dashboard has no PostHog script, no cookie and no browser storage for analytics. Each event is counted at the server action that makes it true (so it survives a UI rebuild).
- **Straight to PostHog, never through a proxy on our own domain.** `POSTHOG_HOST` must be one of PostHog's own ingestion hosts, the origin only, no path: `https://us.i.posthog.com` (US Cloud) or `https://eu.i.posthog.com` (EU Cloud) ([capture API](https://posthog.com/docs/api/capture)). Anything else (a path on `readysetmail.com`, another host, a path after PostHog's host) leaves analytics off, and the owner's setup check (**Settings → Instance**, `GET /api/instance/preflight`, item `product_analytics`) says why without showing the value. The reason: a Worker's request to its own Cloudflare zone carries the visitor's address ("In same-zone Worker subrequests, the value of `CF-Connecting-IP` reflects the value of `x-real-ip` (the client's IP)", [Cloudflare HTTP headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/)). The first-party reverse proxy that is right for the website's **browser** events must therefore never be used for this **server-side** capture. A loopback address in `POSTHOG_HOST` is refused like any other. Tests and the e2e send to a local fake through the separate, testing-only `POSTHOG_API_BASE` (as `STRIPE_API_BASE` does for Stripe): honoured only as exactly `http://127.0.0.1:<port>` or `http://localhost:<port>` (no userinfo, path, query or fragment), and only when analytics is otherwise on (`MODE=saas`, a valid key, `POSTHOG_HOST` one of the two hosts); the batch then goes to `${POSTHOG_API_BASE}/batch/`. When it is set to anything else analytics is off (never a silent fall back to the real host) and the setup check says why, without the value. Leave it unset on the hosted service.
- One `POST ${POSTHOG_HOST}/batch/` per action (`${POSTHOG_API_BASE}/batch/` under test), `{ api_key, batch: [{ event, distinct_id, timestamp, properties }] }` ([capture API](https://posthog.com/docs/api/capture)).
- **Timestamps:** when the step happened (the moment the server action ran, not when the batch leaves after background reads), to the whole second (`2026-11-15T12:00:07Z`). Events of one action keep their causal order (e.g. `Code Verified` then `Workspace Created`) and never go backwards inside a batch. Two steps in the same second tie; PostHog's ordered funnels still count them, because its funnel function takes "different events with the same timestamp" and processes them in step order ([`funnel-udf/src/steps.rs`](https://github.com/PostHog/posthog/blob/master/funnel-udf/src/steps.rs)), so no artificial offset is added.
- After the response, inside `ctx.waitUntil` (the cron and the email handler pass theirs): a 3-second timeout, **one** retry on a 5xx, 429 or network error (none on a 4xx), every error swallowed. A slow or failing PostHog never delays or fails a request. The settings are read with type checks, and `capture`, `captureMany` and `captureLater` catch everything at their boundary (never thrown; each drop is one log line, `[product-analytics] dropped: <stage>`, with no detail that could carry a value), so a malformed setting or a failing hook cannot fail the request, the Stripe webhook, the report intake or the cron it rides on.
- **Personless:** `$process_person_profile: false` on every event, with a random distinct id. No `identify`, alias or person profile.
- **No IP:** the request carries only `Content-Type`; nothing of the visitor's request (IP, `CF-Connecting-IP`, `X-Forwarded-For`, `Forwarded`, `X-Real-IP`, User-Agent, cookies) is copied, and no `$ip` is ever set. PostHog sees Cloudflare's egress address only, and `$geoip_disable: true` keeps it from being geolocated. The project also has "Discard client IP data" on.
- Every event carries `surface: "app"` (the website's carry `web`) and `$lib: "ready-set-mail-worker"`.

## Identity

Each workspace has one random analytics id (a UUID made with `crypto.randomUUID()`), stored in the existing `settings` table (`analytics_id`; no migration). It is never derived from the email, a domain, the user id or the workspace id, and **it is always minted by the Worker**: nothing a browser or a link sends can choose or reuse it (there is no website visitor id). Every event about a workspace uses it as `distinct_id`; there is no per-person id, so a teammate's steps count for the workspace they join (which is what the teammate funnel needs).

A sign-up by email code has no workspace until its code is right, so the pending sign-up attempt carries a freshly minted id (a small tag in its `verifications` row, set for every attempt alike, never sent to the browser, gone with the attempt; "send a new code" from the same browser keeps it). When the code is right, the new workspace adopts that id. A Google or GitHub sign-up creates the workspace at once and gets its random id there.

**Where a sign-up came from.** The website links into sign-up with `src=<page class>` (`home`, `checker`, `report`, `agencies`, `pricing`, `errors`, `tools`, `other`) and, from the checker, `domain=<the checked domain>` (the existing carry-over that pre-fills the first domain). The dashboard reads both from the link before it renders, keeps them in memory only (no cookie, no browser storage; a reload forgets them) and sends `src` and `from_checker` (a boolean: whether `domain=` was there; the domain itself is never sent for analytics) with the sign-up form. The server keeps `src` as the `entry` property only from that closed list: any other value is `other`, no `src` is `cold`. The website itself measures with Plausible; the two are joined by `entry`, not by an id.

Deleting a workspace deletes its id and markers (the settings rows cascade): the only link between the account and its events ([data retention](data-retention.md#product-analytics-hosted)).

## What is never sent

Email addresses, names, organization or workspace names, domain names, DNS record values, verification tokens, IP addresses, user agents, Cloudflare account or zone ids or names, Stripe ids, order ids, amounts, free-text answers ("where did you hear about us" is sent only as filled or not), or any id other than the analytics id. Properties are categories and buckets from closed lists; `capture()` drops any property not in `events.ts` and any value not listed for it, before sending.

How the tests prove it (ticket A7): `test/product-analytics/analytics.test.ts` (1) puts a forbidden value (an email, a domain, an IPv4/IPv6 address, `v=spf1`, `v=DMARC1`, `readysetmail-verify=`, a Stripe id, a workspace id, a UUID, an account name) into every property of every event and checks it is dropped; (2) checks no allowed value or name looks like any of those; (3) scans every capture call site in `src/` and checks each names a listed event and property, literal values come from the list, and no value is read from headers, emails, names, domains, tokens or ids; (4) walks a hosted instance with the repo's fakes along each path (`test/product-analytics/walk.ts`): Cloudflare OAuth (sign-up from the checker with a stray `vid` that must be ignored and a resent code, a teammate, a typed domain, OAuth and import, the DMARC Apply, records live, the first report, a card, an order paid by the fake Stripe's webhook, delivered, a sign-in), a pasted Cloudflare token, records added by hand (TXT proof, record added at the DNS host, seen on the domain page, the daily job), and a sign-up and sign-in with GitHub; it checks every outgoing request: the URL, only `Content-Type` (a request carrying `X-Forwarded-For`, `CF-Connecting-IP`, `Forwarded`, `X-Real-IP`, a User-Agent and a cookie forwards none of them), no forbidden pattern, no UUID but the analytics ids, none of the walk's emails, domains, password, workspace or order id; and that each path's funnels finish in timestamp order. `ANALYTICS_PATHS_OUT=<file>` writes the four captured walks. `e2e/product-analytics.spec.ts` repeats the token walk on a real `wrangler dev` with a fake PostHog, and checks a hosted instance without the key sends nothing.

## Events

All properties are optional and dropped when not in the list. Buckets: `COUNT` = `0` `1` `2-5` `6-20` `21+`; `SHORT_WAIT` = `none` `under_1m` `1_10m` `10_60m` `1_24h` `over_24h`; `LONG_WAIT` = `none` `under_1h` `1_24h` `24_48h` `48_72h` `3_7d` `over_7d`.

### Sign-up and sign-in (`src/auth/routes.ts`)

| Event | When | Properties |
|---|---|---|
| `Signup Started` | `POST /api/auth/signup` answered for a new attempt (every address alike, so nothing says whether it had an account); or a Google/GitHub sign-up that created an account (`src/auth/index.ts`) | `method` (`email_code` `oauth_google` `oauth_github`), `entry` (`home` `checker` `report` `agencies` `pricing` `errors` `tools` `other` `cold`; email code only: the provider's redirect carries no `src`), `from_checker` (bool) |
| `Signup Code Sent` | a sign-up code was handed to the mail provider (first, or asked for again) | `send` (`first` `resend`) |
| `Code Verified` | `POST /api/auth/code` right, for a sign-up or an invite | `purpose` (`signup` `invite`), `entry`, `from_checker` (bool), `attempts` (`1` `2` `3+`), `resends` (`0` `1` `2+`), `wait` code sent → typed (`under_1m` `1_5m` `5_15m` `15_60m` `over_1h`), `account_created` (bool) |
| `Workspace Created` | the sign-up's workspace (email code or Google/GitHub), or `POST /api/workspaces` | `source` (`signup` `added`), `method` (on `signup`: `email_code` `oauth_google` `oauth_github`) |
| `Signed In` | a sign-in completed: password, emailed code, or a Google/GitHub sign-in to an existing account | `method` (`code` `password` `oauth_google` `oauth_github`) |
| `Signup Profile Saved` | `POST /api/auth/signup/profile` saved the S2 "about you" answers on the pending attempt (`src/auth/routes.ts`; the free text itself is never sent) | `whose_email` (`company` `clients` `looking`), `role` (`founder` `developer` `it` `marketing` `agency` `other` `none`), `heard_about_given` (bool) |
| `Setup Path Chosen` | the S4 setup choice: Connect Cloudflare or the records path (`POST /api/onboarding/setup-path`, `src/onboarding/routes.ts`; once per path per screen), or "Hand setup to a teammate" (`POST /api/team/invite` with a `handoff_domain`, `src/api/router.ts`) | `path` (`cloudflare` `records` `dns_manager` `teammate`), `dns_provider` |

### Dashboard, teammates, workspaces

| Event | When | Properties |
|---|---|---|
| `Dashboard First Viewed` | the first `GET /api/me` of a workspace by a signed-in person | `state` (`no_domains` `proof_pending` `domains` `records_live`), `role` (`owner` `admin` `member`) |
| `Workspace Active` | `GET /api/me`, at most once per workspace and UTC day | `role`, `domains` (`COUNT`) |
| `Invite Sent` | `POST /api/team/invite` | `role` (`admin` `member`) |
| `Invite Accepted` | the invited address's code is right and the invite is claimed | `role`, `wait` since the invite (`SHORT_WAIT`) |

### Domains, Cloudflare, records, reports

| Event | When | Properties |
|---|---|---|
| `Domain Added` | a request that added domains or claims: typed (`POST /api/domains`, the setup wizard's `POST /api/settings/base-domain`), an agent's `add_domain`, bulk import, a Cloudflare import; a repeat counts nothing. A pending claim is counted once, when it is made (a once-only `claim:<id>` marker, since `admitDomain` returns the same claim on a repeat, whichever of the two typed routes asks); proving it later is only `Ownership Verified`, on every route, never a second `Domain Added` | `source` (`typed` `agent` `bulk` `cloudflare_import`: how it was entered; **no `path`**, because the way ownership is proven is not known yet), `needs_proof` (bool), `added` (`COUNT`), `domains` verified after (`COUNT`), `dns_provider` (`cloudflare` `godaddy` `porkbun` `namecheap` `route53` `google-cloud-dns` `squarespace` `digitalocean` `vercel` `ns1` `other` `mixed` `unknown`; read from public NS records in the background), `verdict_issues` (`0` `1` `2` `unknown`: no SPF; no DMARC or `p=none`) |
| `Ownership Verified` | a domain row inserted with its ownership established | `path` (**how the ownership was proven**: `cloudflare` when proven by the zone, `manual` for `txt`, `parent` and `selfhost`; this is the step the path funnels key off), `method` (`cloudflare_zone` `txt` `parent` `selfhost`), `wait` since its claim (`SHORT_WAIT`; `none` when there was no claim) |
| `Cloudflare Connect Started` | `POST /api/cloudflare/oauth/start`, or a pasted token connected (`POST /api/cloudflare/connections`: sent together with its Returned, Started first) | `path` (`cloudflare`), `method` (`oauth` `token`) |
| `Cloudflare Connect Returned` | the OAuth callback (connected, denied, failed) or a pasted token connected | `path`, `method` (`oauth` `token`), `result` (`connected` `denied` `failed`), `zones` allow-listed (`COUNT`), `accounts` (`COUNT`) |
| `Apply Clicked` | `POST /api/onboarding/dns-apply` (a plan step), `POST /api/domains/:id/report-address/apply` (Connect reports) or `POST /api/domains/:id/apply-dmarc` (Cloudflare path only) | `path` (`cloudflare`), `step` (`dmarc` `reports_mailbox` `dmarc_record`), `changes` (`COUNT`) |
| `Apply Done` | the same request finished | `path`, `step`, `result` (`applied` `partial` `failed` `nothing_to_do`), `changes`, `reports` (`connected` `refused` `none`) |
| `Records Live` (**value**) | the first time a read sees a domain's DMARC record sending reports to its report address, once per domain: a setup screen's read (`onboarding-status`, `first-check`), the domain page's DNS check (`GET /api/domains/:id/dns-check`, where records added by hand are usually seen), or the daily job (up to a day late) | `path` (the domain's proof path, as on `Ownership Verified`, **not** whether our Apply wrote the records), `records_by` (`apply`: our Apply wrote them, from the `applied:<id>` marker; `hand`: the person did), `seen_by` (`setup` `domain_page` `daily`), `method`, `since_signup` (`LONG_WAIT`), `since_apply` seconds-to-public-DNS (`SHORT_WAIT`), `domains_live` (`COUNT`) |
| `First Report Received` (**value**) | the first aggregate report stored for a domain (hosted intake), once per domain | `path` and `records_by` (as on `Records Live`), `since_live` (`LONG_WAIT`) |
| `No Report After 3 Days` | daily 11:00 UTC: domains live for 3 days with no report yet, each counted once | `domains_waiting` (`COUNT`) |
| `Email Check Started` / `Email Check Done` | a signed-in person's free email check: address issued / result read | Done: `result` (`protected` `at_risk` `exposed` `other`) |

### Agents and billing

| Event | When | Properties |
|---|---|---|
| `Agent Authorized` | "Allow access" completed (`src/mcp/connections.ts`) | `actions`, `domains` (`COUNT`), `days` (`1` `2-7` `8-30`) |
| `Agent First Call` (**value**) | an agent connection's first successful tool call | `tool` (the ten tool names) |
| `Fix Offer Viewed` | `GET /api/billing/domains/:id` for an owner who can buy | `offer` (`fix_one_domain`), `has_card` (bool) |
| `Card Setup Started` / `Card Setup Completed` | Stripe Checkout (setup) session made / its card made the default | — |
| `Fix Order Created` | the order row inserted | `offer`, `price_tier` (`list`) |
| `Fix Order Paid` (**money**) | the order moved to paid (`invoice.paid`, reconciliation) | `offer`, `price_tier` (`list`; `reduced` when Stripe collected less than the price) |
| `Fix Order Failed` | failed or canceled | `offer`, `reason` (`failed` `canceled`) |
| `Fix Order Refunded` | fully refunded | `offer` |
| `Fix Order Delivered` (**finish line**) | the operator marked it done | `offer`, `since_paid` (`LONG_WAIT`) |

## Funnels

`scripts/posthog-setup.mjs` creates these (ordered funnels, counted per analytics id, i.e. per account; equal-second steps count in step order). "Setup started" is the action **RSM Setup Started** = `Domain Added` or `Cloudflare Connect Started` (OAuth or a pasted token). A domain's setup goes one of two ways, and `path` always means **how the domain's ownership was proven**, decided where that is known (`Ownership Verified`, from the proof method) and carried by `Records Live` and `First Report Received` from the domain's proof:

- **Cloudflare** (`path = cloudflare`): the domain proven by its zone in a connected Cloudflare account. The Cloudflare steps (`Cloudflare Connect Started/Returned`, `Apply Clicked/Done`) are always `cloudflare`.
- **Manual** (`path = manual`): the domain proven by a TXT record, a proven parent or self-host (`method`), whatever DNS host and whoever wrote the records.

`Domain Added` has no `path`: it only says how the domain was entered (`source`). So a domain **typed on a workspace already connected to Cloudflare and then proven by its Cloudflare zone** is `Domain Added` (`source = typed`) → `Ownership Verified` (`path = cloudflare`) → `Records Live` (`path = cloudflare`), and stays in the Cloudflare funnel. Who wrote the records is a separate property, `records_by` (`apply` or `hand`): a TXT-proven domain whose records were written through Cloudflare by Apply is `path = manual`, `records_by = apply`.

1. **Onboarding, sign-up to first report** (14 days, both paths, every sign-up method): `Signup Started` → `Workspace Created` → `Dashboard First Viewed` → Setup started → `Ownership Verified` → `Records Live` → `First Report Received`. No Apply step, so people who add records by hand are not shown lost at Apply.
2. **Sign-up by email code** (1 day): `Signup Started` (`method = email_code`) → `Signup Code Sent` → `Code Verified` → `Workspace Created`.
3. **Cloudflare path** (7 days): `Cloudflare Connect Started` → `Cloudflare Connect Returned` (`result = connected`) → `Ownership Verified` (`path = cloudflare`) → `Apply Clicked` → `Apply Done` → `Records Live` (`path = cloudflare`). Apply steps appear only here.
4. **Manual path** (7 days): `Domain Added` (any `source` except `cloudflare_import`) → `Ownership Verified` (`path = manual`) → `Records Live` (`path = manual`).
5. **Path to purchase** (30 days): `Records Live` → `Fix Offer Viewed` → `Card Setup Started` → `Card Setup Completed` → `Fix Order Created` → `Fix Order Paid` → `Fix Order Delivered`.
6. **Teammate hand-off** (7 days): `Invite Sent` → `Invite Accepted` → `Records Live`.
7. **Agent** (1 day): `Agent Authorized` → `Agent First Call`.

**How far each step can be trusted.** Sign-up, workspace, Cloudflare connect, ownership and Apply steps are recorded by the server action itself, on every path, at the second it happened. `Records Live` is exact when our Apply wrote the records (`records_by = apply`: the setup screen reads DNS right after Apply). When the person added them by hand (`records_by = hand`) it is recorded when something reads the record: the domain page's DNS check (when the person looks) or, at the latest, the daily job, so it can be up to a day late; `seen_by` says which. `entry` exists only for the email-code sign-up (`cold` when no link carried `src`); Google/GitHub sign-ups have none. `First Report Received` depends on the reporter's schedule (usually within a day of records live).

Dashboards: "RSM: Onboarding, sign-up to first report", "RSM: Domain configuration", "RSM: Path to purchase", "RSM: Value moments per week" (records live, first report, teammate joined, agent first call, fix paid and delivered per week; the teammate and agent funnels; active workspaces). At this volume read them as counts and as each account's list of steps, not as rates.

**The script only touches what it made.** Each object it creates carries `managed-by: rsm-setup def:<hash>` at the end of its description. It updates an object only when it carries that marker and its definition changed (a funnel changed here is updated in PostHog on the next run), never modifies, moves or deletes an object without it, and never deletes anything. When a name is already taken by an object it did not create, it creates its own as `<name> (rsm-setup)` and says so. `--dry-run` lists every object as `create`, `update` or `unchanged` and writes nothing.

## Turning it on for the hosted instance

1. **Website first.** The privacy policy must carry this sentence (owner-approved wording) in place of "The dashboard runs no analytics and sends no usage statistics." before the keys are set:

   > The hosted dashboard counts a few steps with PostHog (for example that an account was created, a domain was verified, a first report arrived or a fix was ordered), with a random number in place of your account. It never sends your email address, your domains, your DNS records or your IP address. A self-hosted installation sends nothing.

2. **The two variables** on the hosted Worker (not secrets in the strict sense: the project key is public, but keep them out of `wrangler.jsonc`):
   ```sh
   npm run wrangler -- secret put POSTHOG_KEY    # the project key, phc_…
   npm run wrangler -- secret put POSTHOG_HOST   # https://us.i.posthog.com
   ```
   `GET /api/auth/status` then answers `product_analytics: true`, and Settings shows "Usage analytics: On".
3. **Check it arrives:** sign up with a test address, then in PostHog → Activity → Live events filter on `surface = app`: `Signup Started`, `Signup Code Sent`, `Code Verified`, `Workspace Created`, `Dashboard First Viewed` appear within a minute, all under one random distinct id, with no person profile.
4. **Create the funnels and dashboards** with the owner's PostHog personal API key (Settings → User → Personal API keys, scopes `project:read`, `insight:write`, `dashboard:write`, `action:write`). The owner's key is **scoped to the one project**: organisation endpoints answer it 403, so the project is always given by its numeric id (Project settings → Project ID); `@current` is not accepted (it is sent URL-encoded and PostHog answers 403). The key is read from the environment, never printed or stored:
   ```sh
   POSTHOG_PERSONAL_API_KEY=phx_… node scripts/posthog-setup.mjs --project <id> --dry-run   # create / update / unchanged, per object
   POSTHOG_PERSONAL_API_KEY=phx_… node scripts/posthog-setup.mjs --project <id>             # apply
   ```
   `POSTHOG_APP_HOST` defaults to `https://us.posthog.com` (the private API host; `https://eu.posthog.com` on EU Cloud). Running it again changes nothing unless a definition here changed. The objects already in the project that the script did not make stay exactly as they are.

To turn it off, delete either variable: the Worker stops sending at once.

## The new sign-up screens (PR 177)

S1 sends `src` and `from_checker` with the sign-up request (`signupAnalytics()`, `web/src/pages/auth/SignupFlow.tsx`); the resend endpoint passes `signupHooks` to `answerWithCode`, so a resent code keeps the attempt's id and counts as `Signup Code Sent` `resend`; saving S2 counts `Signup Profile Saved`; the S4 choice counts `Setup Path Chosen` (`dns_provider` is the host's id when it is one the product recognises, `other` when not, `unknown` when none). Tests: `test/product-analytics/`.
