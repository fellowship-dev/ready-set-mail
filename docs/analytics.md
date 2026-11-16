# Product analytics (hosted dashboard, PostHog)

Internal. How the hosted dashboard counts the steps people take, so the funnels show where each account stops: sign-up and onboarding to records live and the first report, domain configuration, and the path to a paid fix.

**Off by default.** Nothing is sent unless the Worker runs with `MODE=saas` **and** both `POSTHOG_KEY` and `POSTHOG_HOST` are set. A self-hosted installation never sends anything, whatever it sets; `npm run setup` sets neither variable, and `MODE=saas` alone does not turn it on. The opt-in self-host telemetry that used to exist (`src/telemetry.ts`, the "Share anonymous usage stats" checkbox) is removed: its endpoint never resolved, so it never sent anything either.

Code: `src/product-analytics/` (`events.ts` the allow-list, `capture.ts` the sender, `identity.ts` the id, `auth.ts` and `steps.ts` the hooks). Tests: `test/product-analytics/`, `test/scripts/posthog-setup.test.ts`, `e2e/product-analytics.spec.ts`.

## How an event is sent

- **Server-side only, from the Worker.** The dashboard has no PostHog script, no cookie and no browser storage for analytics. Each event is counted at the server action that makes it true (so it survives a UI rebuild).
- One `POST ${POSTHOG_HOST}/batch/` per action, `{ api_key, batch: [{ event, distinct_id, timestamp, properties }] }` ([capture API](https://posthog.com/docs/api/capture)).
- After the response, inside `ctx.waitUntil` (the cron and the email handler pass theirs): a 3-second timeout, **one** retry on a 5xx, 429 or network error (none on a 4xx), every error swallowed. A slow or failing PostHog never delays or fails a request.
- **Personless:** `$process_person_profile: false` on every event, with a random distinct id. No `identify`, alias or person profile.
- **No IP:** the request carries only `Content-Type`; nothing of the visitor's request (IP, `CF-Connecting-IP`, `X-Forwarded-For`, User-Agent, cookies) is copied, and no `$ip` is ever set. PostHog sees Cloudflare's egress address only, and `$geoip_disable: true` keeps it from being geolocated. The project also has "Discard client IP data" on.
- Every event carries `surface: "app"` (the website's carry `web`) and `$lib: "ready-set-mail-worker"`.

## Identity

Each workspace has one random analytics id (a UUID made with `crypto.randomUUID()`), stored in the existing `settings` table (`analytics_id`; no migration). It is never derived from the email, a domain, the user id or the workspace id. Every event about a workspace uses it as `distinct_id`; there is no per-person id, so a teammate's steps count for the workspace they join (which is what the teammate funnel needs).

A sign-up has no workspace until its code is right, so the pending sign-up attempt carries the id (a small tag in its `verifications` row, set for every attempt alike and gone with it; "send a new code" from the same browser keeps it). When the code is right, the new workspace adopts that id.

**The website's visitor id.** A link from readysetmail.com into sign-up may carry `vid=<the page's random UUID>` (and `from=checker|report|agencies|header|pricing`). The dashboard reads both from the link before it renders, keeps them in memory only (a reload forgets them) and sends them with the sign-up form. The server accepts `vid` only as a canonical lowercase UUID, only on a hosted sign-up, only for the workspace that sign-up creates and only before that workspace has an id; anything else gets a random id. Reusing one `vid` for several sign-ups would only merge those workspaces' analytics. With the same id on both sides, the website's steps and the app's join up in one funnel without `identify`.

Deleting a workspace deletes its id and markers (the settings rows cascade): the only link between the account and its events ([data retention](data-retention.md#product-analytics-hosted)).

## What is never sent

Email addresses, names, organization or workspace names, domain names, DNS record values, verification tokens, IP addresses, user agents, Cloudflare account or zone ids or names, Stripe ids, order ids, amounts, free-text answers ("where did you hear about us" is sent only as filled or not), or any id other than the analytics id. Properties are categories and buckets from closed lists; `capture()` drops any property not in `events.ts` and any value not listed for it, before sending.

How the tests prove it (ticket A7): `test/product-analytics/analytics.test.ts` (1) puts a forbidden value (an email, a domain, an IPv4/IPv6 address, `v=spf1`, `v=DMARC1`, `readysetmail-verify=`, a Stripe id, a workspace id, a UUID, an account name) into every property of every event and checks it is dropped; (2) checks no allowed value or name looks like any of those; (3) scans every capture call site in `src/` and checks each names a listed event and property, literal values come from the list, and no value is read from headers, emails, names, domains, tokens or ids; (4) walks a hosted instance with the repo's fakes (sign-up with a visitor id and a resent code, a teammate, a typed domain, Cloudflare OAuth and import, the DMARC Apply, records live, the first report, a card, an order paid by the fake Stripe's webhook, delivered, a sign-in) and checks every outgoing request: the URL, only `Content-Type`, no forbidden pattern, no UUID but the analytics ids, none of the walk's emails, domains, password, workspace or order id. `e2e/product-analytics.spec.ts` repeats the walk on a real `wrangler dev` with a fake PostHog, and checks a hosted instance without the key sends nothing.

## Events

All properties are optional and dropped when not in the list. Buckets: `COUNT` = `0` `1` `2-5` `6-20` `21+`; `SHORT_WAIT` = `none` `under_1m` `1_10m` `10_60m` `1_24h` `over_24h`; `LONG_WAIT` = `none` `under_1h` `1_24h` `24_48h` `48_72h` `3_7d` `over_7d`.

### Sign-up and sign-in (`src/auth/routes.ts`)

| Event | When | Properties |
|---|---|---|
| `Signup Started` | `POST /api/auth/signup` answered for a new attempt (every address alike, so nothing says whether it had an account) | `entry` (`checker` `report` `agencies` `header` `pricing` `cold`), `visitor_id` (`passed` `fresh`) |
| `Signup Code Sent` | a sign-up code was handed to the mail provider (first, or asked for again) | `send` (`first` `resend`) |
| `Code Verified` | `POST /api/auth/code` right, for a sign-up or an invite | `purpose` (`signup` `invite`), `entry`, `from_checker` (bool), `attempts` (`1` `2` `3+`), `resends` (`0` `1` `2+`), `wait` code sent → typed (`under_1m` `1_5m` `5_15m` `15_60m` `over_1h`), `account_created` (bool) |
| `Workspace Created` | the sign-up's workspace, or `POST /api/workspaces` | `source` (`signup` `added`) |
| `Signed In` | a sign-in completed | `method` (`code` `password`) |
| `Signup Profile Saved` | **waiting on PR 177**: the S2 "about you" answers saved | `whose_email` (`company` `clients` `looking`), `role` (`founder` `developer` `it` `marketing` `agency` `other` `none`), `heard_about_given` (bool) |
| `Setup Path Chosen` | **waiting on PR 177**: the S4 setup choice | `path` (`cloudflare` `records` `dns_manager` `teammate`), `dns_provider` |

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
| `Domain Added` | a request that added domains or claims: typed (`POST /api/domains`, the wizard's base domain), an agent's `add_domain`, bulk import, a Cloudflare import; a repeat counts nothing | `source` (`typed` `agent` `bulk` `cloudflare_import`), `needs_proof` (bool), `added` (`COUNT`), `domains` verified after (`COUNT`), `dns_provider` (`cloudflare` `godaddy` `porkbun` `namecheap` `route53` `google-cloud-dns` `squarespace` `digitalocean` `vercel` `ns1` `other` `mixed` `unknown`; read from public NS records in the background), `verdict_issues` (`0` `1` `2` `unknown`: no SPF; no DMARC or `p=none`) |
| `Ownership Verified` | a domain row inserted with its ownership established | `method` (`cloudflare_zone` `txt` `parent` `selfhost`), `wait` since its claim (`SHORT_WAIT`; `none` when there was no claim) |
| `Cloudflare Connect Started` | `POST /api/cloudflare/oauth/start` | `method` (`oauth`) |
| `Cloudflare Connect Returned` | the OAuth callback (connected, denied, failed) or a pasted token connected | `method` (`oauth` `token`), `result` (`connected` `denied` `failed`), `zones` allow-listed (`COUNT`), `accounts` (`COUNT`) |
| `Apply Clicked` | `POST /api/onboarding/dns-apply` (a plan step) or `POST /api/domains/:id/apply-dmarc` | `step` (`dmarc` `reports_mailbox` `dmarc_record`), `changes` (`COUNT`) |
| `Apply Done` | the same request finished | `step`, `result` (`applied` `partial` `failed` `nothing_to_do`), `changes`, `reports` (`connected` `refused` `limit` `unavailable` `none`) |
| `Records Live` (**value**) | the first stored DNS read of a domain whose DMARC record sends reports to its report address (`domains.dmarc_rua = 1`), once per domain | `method`, `since_signup` (`LONG_WAIT`), `since_apply` seconds-to-public-DNS (`SHORT_WAIT`), `domains_live` (`COUNT`) |
| `First Report Received` (**value**) | the first aggregate report stored for a domain (hosted intake), once per domain | `since_live` (`LONG_WAIT`) |
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

`scripts/posthog-setup.mjs` creates these (by name; ordered funnels, counted per analytics id, i.e. per account). "Setup started" is the action **RSM Setup Started** = `Domain Added` or `Cloudflare Connect Started`.

1. **Onboarding, sign-up to first report** (14 days): `Signup Started` → `Signup Code Sent` → `Code Verified` → `Dashboard First Viewed` → Setup started → `Ownership Verified` → `Apply Done` → `Records Live` → `First Report Received`. With the website's `vid`, its `Check Completed` and `Signup Link Opened` can be put in front.
2. **Domain configuration** (7 days): Setup started → `Ownership Verified` → `Apply Clicked` → `Apply Done` → `Records Live`; plus Cloudflare connect started → returned, and breakdowns by `dns_provider`, `method`, `result`, `since_apply`.
3. **Path to purchase** (30 days): `Records Live` → `Fix Offer Viewed` → `Card Setup Started` → `Card Setup Completed` → `Fix Order Created` → `Fix Order Paid` → `Fix Order Delivered`.
4. **Teammate hand-off** (7 days): `Invite Sent` → `Invite Accepted` → `Records Live`.
5. **Agent** (1 day): `Agent Authorized` → `Agent First Call`.

Dashboards: "RSM: Onboarding, sign-up to first report", "RSM: Domain configuration", "RSM: Path to purchase", "RSM: Value moments per week" (records live, first report, teammate joined, agent first call, fix paid and delivered per week; the teammate and agent funnels; active workspaces). At this volume read them as counts and as each account's list of steps, not as rates.

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
4. **Create the funnels and dashboards** with the owner's PostHog personal API key (Settings → User → Personal API keys, scopes `project:read`, `insight:write`, `dashboard:write`, `action:write`). It is read from the environment, never printed or stored:
   ```sh
   POSTHOG_PERSONAL_API_KEY=phx_… POSTHOG_PROJECT_ID=<id> node scripts/posthog-setup.mjs --dry-run   # what it would create
   POSTHOG_PERSONAL_API_KEY=phx_… POSTHOG_PROJECT_ID=<id> node scripts/posthog-setup.mjs             # create what is missing
   ```
   `POSTHOG_APP_HOST` defaults to `https://us.posthog.com` (the private API host; `https://eu.posthog.com` on EU Cloud). Running it again creates nothing new.

To turn it off, delete either variable: the Worker stops sending at once.

## Waiting on the new sign-up (draft PR 177)

The events and helpers exist and are tested; their call sites live on the `onboarding-signup-first-run` branch. When it merges, add (one line each, see the comment at the end of `src/product-analytics/auth.ts`):

- `POST /api/auth/signup/profile`, after `saveAttemptProfile`: `signupProfileSaved(env, ctx, handle, checked.profile)` → `Signup Profile Saved`.
- `POST /api/auth/signup/resend`: pass `{ notice: 'signup', analytics: signupHooks(env, ctx, await signupTag(env, handle, {})) }` to `answerWithCode`, so a resent code keeps the attempt's id and counts as `Signup Code Sent` `resend`.
- The S4 setup choice: `setupPathChosen(env, ctx, workspaceId, path, dnsProvider)` at the server call the choice makes (or a small POST the screen adds) → `Setup Path Chosen`.
- `web/src/pages/auth/SignupFlow.tsx` (S1): add `...signupAnalytics()` (`web/src/lib/visitor.ts`) to the sign-up request body, as `AuthPage.tsx` does on `main`.
