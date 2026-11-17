# MTA-STS

How Ready Set Mail turns on MTA-STS for a domain, on the hosted service and on a self-hosted install, what it writes, when it lets you enforce, how it comes off again and what the operator sets up. The decision record is [ADR 0026](adr/0026-mta-sts-customer-zone-records-and-saas-policy-host.md); the API is under [MTA-STS in docs/hosted.md](hosted.md#mta-sts).

## What it is, in plain words

Email between mail servers is encrypted only if both sides agree to it, and a person in the middle can make them not agree. MTA-STS (RFC 8461) is a promise a domain publishes: "when you deliver mail to me, use an encrypted connection (TLS) to one of these mail servers (the MX hosts), or tell me it failed." Senders that support it (Gmail, Microsoft and most large providers do) read the promise, and then send you a daily **TLS report** about how their deliveries went. The promise has two modes: **testing** (senders deliver as before and report problems; nothing is rejected) and **enforce** (a sender that cannot use an encrypted connection to your servers does not deliver).

## What you get

One page per domain, `/#/domains/:id/mta-sts`, opened from the MTA-STS card under "DNS tools" on the domain page. That section stays hidden when neither tool is available nor set up (a hosted service without policy hosting configured shows no MTA-STS card at all), and its one-line summary names only the tools listed. The card says the real state in a word: **Off**, **Setting up**, **Testing**, **Enforced**, or **Not available** with a short reason.

The page is short on purpose (the enable path is about 330 words on screen): the records Ready Set Mail writes for you sit behind **Show records**, and nothing explains what a CNAME is.

- **Before it is on:** one sentence of what it is, the MX hosts found now, and one action, **Turn on in testing mode**. If there are no MX records, or the lookup failed, the page says which (they are not the same) and offers no action. If it cannot be turned on, the page says why in one sentence and offers no button. A setup that was stopped after 7 days says so here and how to restart ("Turn it on again to restart"). A policy that is being switched off says what senders may still do and until when.
- **While it sets up:** one sentence for where it stands (waiting for records, the certificate, or the policy file to be reachable), the setup checks in words (In place, Waiting, Not found yet, Wrong, Couldn't check), the records still to add by hand, and **Check now** with the time of the last check. The page also looks again by itself every 30 seconds for half an hour.
- **Once the policy is served:** "Served at https://mta-sts.<domain>/..." is the result of the last **fetch** of that address (see "Served means fetched" below), nothing else. "Checked <time>" (UTC) says when it was fetched, and a small secondary **Check now** stays, because that claim can go stale. **Switch to enforce** is the filled action once it can be pressed; until then it is not filled, and under it stands the whole rule, once, with each line marked Met or Missing now (7 days in testing; a report signed by Google or Microsoft, plus any sender the operator added, about this policy and with successful sessions; no failures in signed reports about this policy in the last 14 days; the MX hosts match the policy; the policy is served), the missing ones with their reason, and one sentence of its consequence ("A domain that receives no TLS reports can never switch to enforce."). A verified report whose period ended before the current policy was published is said as that ("A verified report arrived, but it covers a period before this policy was published."), also after a switch back from enforce, because the id changes. The TLS reports of the last 30 days follow: the table lists the **counted** reports and the sentence above it sums exactly those (who sent each, which days, successful and failed sessions, the failure types in plain words), and reports that could not be verified are one separate sentence with their count ("1 more report arrived but is not counted: sender not verified."), whatever `REPORT_COUNTING` says. When the last fetch of the policy is older than 10 minutes (a certificate or record change settles in a few minutes) the server fetches it once when the page is opened (4 seconds at most; `SERVED_FRESH_SECONDS` in `src/mta-sts/service.ts`), stores the result before it answers, and the page shows "Served" or "The policy cannot be reached" from it, and the enforce line "The policy is served" from the same result. When that fetch gets no answer in time, nothing is stored and the page says "Could not check just now" with the last known result and its time; the enforce line is then Missing ("The policy could not be checked just now."). The line under "Show records" says how long senders may keep the policy: one day in testing, a week in enforce, and after leaving enforce "Senders that fetched the enforce policy may keep it until <date>" (the switch plus a week), never the testing policy's one day.
- **When the fetch fails** (the policy is not "served"): a warning says the policy cannot be reached with the one action, **Check now**, and Switch to enforce is off.
- **A notice** appears on the page when something changed that you should know: the MX hosts changed (the policy has a new id; by hand you are asked to publish it), the mode went back to testing because a new MX host has no TLS evidence, no MX records were found at the last daily check. You dismiss it.

## The records

Three records, all in your own zone:

| Name | Type | Value | Why |
|---|---|---|---|
| `mta-sts.<domain>` | CNAME | the policy server: on the hosted service the operator's `POLICY_HOST_TARGET`, **DNS only (grey cloud)**; on self-host the Worker's own host, proxied | senders fetch the policy from `https://mta-sts.<domain>/.well-known/mta-sts.txt`, so this name has to reach the Worker with a certificate they trust |
| `_smtp._tls.<domain>` | TXT | `v=TLSRPTv1; rua=mailto:tls-rpt@<INTAKE_DOMAIN>` (self-host: `tls-rpt@<reports domain>`) | where senders send their reports |
| `_mta-sts.<domain>` | TXT | `v=STSv1; id=<timestamp>` | tells senders a policy exists; senders fetch the policy again only when this id changes. It is written **last**, once the policy is served, and on every change the stored policy changes before the id does (RFC 8461 section 8.1) |

- **Your zone is on Cloudflare and a connection reaches it:** turning it on writes the three records (the id once the certificate is active). Nothing to paste.
- **Otherwise (hosted only):** the page lists the records to add at your DNS host, each with a copy control, in the order they matter: the CNAME and the TLS-RPT record first, the id after the certificate is active. Ready Set Mail reads public DNS to see them arrive. Keep the CNAME **DNS only**: a proxied CNAME in another Cloudflare account to the operator's host cannot work.
- **Records that are already there.** A record at one of the three names whose content is exactly what turning it on would write (the same report address, the same target, an `id`-only `v=STSv1` with our CNAME in place) is adopted: it is kept as it is, its id is stored, and turning MTA-STS off removes it like the others. Anything else at those names is refused and named, never overwritten: for example a TLS reporting record that sends reports elsewhere (a domain can have only one; add our address to it by hand, or remove it).

## The policy file

```
version: STSv1
mode: testing
mx: mail.example.com
mx: mailsec.example.com
max_age: 86400
```

Served by this Worker at `https://mta-sts.<domain>/.well-known/mta-sts.txt`, never cached. On a policy host the Worker answers GET and HEAD of that one path with the policy, and 404s anything else that reaches it (the API, `llms.txt`, the agent endpoints, a POST). What else answers there depends on where the request goes: [Other paths on a policy host](#other-paths-on-a-policy-host). The `mx:` lines are the MX hosts found when it was turned on and at each daily check; a changed list gets a new id.

`max_age` follows the mode (`maxAgeFor` in `src/mta-sts/config.ts`): **86400 (one day) in testing**, so a mistake or an MX change heals within a day (RFC 8461 section 5: start in testing), and **604800 (seven days) in enforce**: section 3.2 says it is "typically ... in the range of weeks or greater", because a short one lets an attacker wait out the cache (Proton serves 604800). `none`, used when a policy is taken down, is one day.

### Other paths on a policy host

Only the policy path matters to a sender. `wrangler.jsonc` keeps its `assets.run_worker_first` list (`/api/*`, `/mcp`, `/mcp/*`, `/oauth/*`, `/.well-known/*`, `/health`, `/llms.txt`, `/relay/*`): `/.well-known/*` is in it, so `GET /.well-known/mta-sts.txt` always runs the Worker, which answers the policy. For every other path:

- **Locally (`wrangler dev`, Host `mta-sts.<domain>`, checked 2026-11-16):** paths in the list are the Worker's 404 (`/api/...`, `/llms.txt`, `/.well-known/other`, a POST to the policy path); `/`, `/nope` and `/assets/missing.js` are 200 and the dashboard's `index.html` (the single-page fallback), `/assets/<real file>` is that file, `/index.html` is a 307 to `/`.
- **Hosted production:** the one declared route, `*/.well-known/mta-sts.txt`, is the only way a customer's `mta-sts.<domain>` reaches this Worker. A static asset is served only for a request that reaches the Worker's version, so any other path never reaches this Worker or the dashboard's files: it goes to the custom hostname's fallback origin, which is the originless `100::` record, and Cloudflare answers with its own error (its documentation warns that a fallback origin without an origin server "can fail with a `522` error": [worker as origin](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/worker-as-origin/); routes: [Workers routes](https://developers.cloudflare.com/workers/configuration/routing/routes/)). **Not verified live.** If an operator ever declared a wider route to this Worker in `POLICY_HOST_ZONE` (`*/*`), the dashboard would answer on customer names; nothing here creates one, the reconcile logs it as an error (`widerRoutes`).
- **Self-host:** `mta-sts.<domain>` is a proxied CNAME to your Worker's own address, so every path reaches your Worker like a request to your instance: the policy path answers the policy, the paths in the list above answer the Worker's 404 on that name, and everything else is your dashboard's single-page app (its sign-in page), the same one your instance serves on its own address. No credentials or data are exposed that the instance's own address does not already show.

### Served means fetched

A policy is "served" only when Ready Set Mail has fetched `https://mta-sts.<domain>/.well-known/mta-sts.txt` itself and got status 200, `Content-Type: text/plain` and exactly the policy it publishes, over HTTPS with a valid certificate (Workers refuse an invalid one, so success is the certificate proof), without following redirects, within 8 seconds, without a cache. That fetch (`src/mta-sts/reconcile.ts`) is part of **Check now**, of the daily job and of opening the page when the last one is over 10 minutes old, and its last result is the only thing the page's "served" shows. While it fails, **the `_mta-sts` id is not published**: not at setup, and not for a mode or MX change (the new policy is stored, fetched, and the change undone if the fetch fails). Setup then waits in `waiting_policy`.

## Testing, then enforce

It always starts in testing: the page offers no choice. **Switch to enforce** is enabled only when all of this holds (`enforceReadiness` in `src/mta-sts/evidence.ts`), and the page lists every rule that does not:

- setup is finished: the policy is served (the fetch above) and the three records are confirmed;
- it has been in testing for at least **7 days**, so senders have had time to report;
- at least one **counted** TLS report ended after the current policy id was published, with successful MTA-STS sessions (reports also count DANE sessions; only the MTA-STS ones count here). A report is counted when it is authenticated and from a known reporter, see below. **One** is enough: it can only be forged by forging Google's or Microsoft's DKIM signature, so a second reporter would add coverage, not authenticity, and most small domains receive mail from only one of the two;
- none of these failures in the counted reports of the last 14 days: `certificate-host-mismatch`, `certificate-expired`, `certificate-not-trusted`, `starttls-not-supported`, `validation-failure`, `sts-policy-fetch-error`, `sts-policy-invalid`, `sts-webpki-invalid`; and no counted report that counts failures without saying why;
- every MX host is a name (not an address) that matches the policy's `mx:` list.

Why: in enforce mode a sender that cannot use TLS to your server drops the mail. The reports are the only evidence that your servers' certificates are valid for the names in the MX records, because the Worker cannot connect to a mail server itself (Cloudflare Workers cannot open outbound connections on port 25). **A domain that receives no TLS reports can never switch to enforce**, and the page says so. **Switch to testing** is always allowed. If the MX list **grows** while enforcing, the mode goes back to testing at the next daily check (the new hosts have no TLS evidence) and a notice says so.

The gate never reads uncounted reports, whatever `REPORT_COUNTING` says: it decides whether mail is refused, so a stranger must never move it. On a **self-hosted** server that has not set `AUTHSERV_ID` and `AUTHSERV_HEADER` nothing can be authenticated, so no report counts, enforce is not offered, and the page says why ([docs/self-hosting.md](self-hosting.md)).

## Turning off, and taking a policy down

**Turn off MTA-STS** is offered only in testing, and only once senders that fetched an enforce policy no longer hold it: from enforce the page says "Switch to testing first. Senders keep the enforce policy for up to 7 days; you can disable it after that." (the time is the enforce policy's `max_age`, 604800, after the switch back). Turning off removes exactly what was made: the records Ready Set Mail wrote, by id (a record you changed since is **kept**, and the result lists it with the reason), and on the hosted service the custom hostname. Then it says how long senders that already fetched the policy may keep it.

**Removing a domain, losing its ownership proof, or another workspace taking the name over (an eviction)** does not take the policy down at once: a sender that fetched an enforce policy refuses mail to servers not in it for up to a week, and nothing would tell it otherwise. It follows RFC 8461 section 8.3 instead (`src/mta-sts/retire.ts`): the policy becomes `mode: none` with `max_age: 86400` (served by name, without proof of the domain: a `none` policy can only stop senders from refusing), a new `_mta-sts` id is published where a Cloudflare connection can write it, and the custom hostname, the records and the entry go once the last served policy's `max_age` has passed since the change: a week after an enforce policy (or one that left enforce within the week), a day after a testing policy. The page and the removal answer say what senders may still do meanwhile; the domain removal dialog says so in one sentence when MTA-STS was enforcing. A policy that was never published goes at once. Turning MTA-STS on again for the name while it retires takes the policy host back. The entry lives in its own table (`mta_sts_retiring`), because a removed domain's config row is deleted with the domain.

**A setup nobody finishes** is stopped after 7 days: Cloudflare deletes a custom hostname that was not validated within seven days anyway ([validation status](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/hostname-validation/validation-status/): a hostname "Moved" for more than seven days is deleted). The hostname and the records are deleted, the slot is free, and the page says "Setup was not finished within 7 days, so it was stopped. Turn it on again to restart."

## TLS reports, and where they show

Senders send them to `tls-rpt@<INTAKE_DOMAIN>` (hosted) or the workspace's reports domain (self-host). On the hosted service one shared address serves everyone: the report names its domain in `policies[].policy.policy-domain`, the intake reads only that field from the start of the report, and files it under the workspace that owns the domain by the one proven-owner rule, if that domain has MTA-STS on and the workspace is admitted to reports (`HOSTED_CONNECT_REPORTS`). Every policy in the report must be covered by that domain, or nothing is stored. Each stored report keeps the sessions under MTA-STS policies apart from the rest (`sts_success`, `sts_failure`, the failure types).

**Who sent it.** RFC 8460 section 3: "Reports sent via SMTP MUST contain a valid DomainKeys Identified Mail (DKIM) [RFC6376] signature by the reporting domain. Reports lacking such a signature MUST be ignored by the recipient." The mail must therefore carry a passing DKIM result in the receiving server's `Authentication-Results` (the same `AUTHSERV_ID` / `AUTHSERV_HEADER` rule DMARC reports use; a DMARC pass that may rest on SPF is not enough), from the reporter's own TLS address (Google: `noreply-smtp-tls-reporting@google.com`; Microsoft: `tlsrpt-noreply@microsoft.com`), with a `contact-info` of that reporter, and the `TLS-Report-Submitter` header (section 5.3: it "MUST match the value found in the domain of the "contact-info" from the report body") naming the signing organisation. Such a report is **counted**. Any other report is still stored and shown, labelled "unverified sender" or by its authenticated organisation, but it is never evidence for enforce, and it is deleted after the uncounted retention (30 days). `INTAKE_KNOWN_REPORTERS` can add a reporter's TLS identity ([docs/hosted.md](hosted.md)).

**Dates.** A report covers a day (section 4.1: "The report SHOULD cover a full day, from 00:00-24:00 UTC") and arrives hours later. One whose dates cannot be read, whose end is not after its start, that covers more than 25 hours, ends more than an hour in the future or more than 14 days ago is refused and nothing is stored. A report sent twice (same reporter, same report-id; without one, same period and policy domain) is accepted and changes nothing.

They show on the MTA-STS page (last 30 days) and, as the sessions under your MTA-STS policy, in the domain's health report ("TLS report history") once MTA-STS is on and set up. Senders usually send one report a day after they deliver mail to you; until then the page says so.

## The hosted operator's setup

MTA-STS needs a certificate for `mta-sts.<customer domain>`, a name in a customer's zone, in another Cloudflare account. The only way the operator's Worker can answer HTTPS for it is **Cloudflare for SaaS**: a custom hostname per customer domain in the operator's zone, validated over HTTP once the customer's CNAME resolves, with the Worker reached through ONE declared route ([Cloudflare for SaaS: getting started](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/getting-started/), [Workers as the fallback origin](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/worker-as-origin/)).

### Operator runbook (hosted)

Setting names are exactly as in `wrangler.jsonc` / the Worker's variables. The same steps, standalone, are in the pull request notes.

**Set up once**

1. **Cloudflare for SaaS** on the zone named by `POLICY_HOST_ZONE` (for example `readysetmail.com`): Custom Hostnames. Use a zone dedicated to policy hosts: the daily cleanup deletes every `mta-sts.<name>` custom hostname in it that no domain owns.
2. **The target.** A proxied, originless record in that zone, for example `mta-sts-host.readysetmail.com AAAA 100::` (proxied), set as the zone's **fallback origin**; wait until Cloudflare says Active. This is `POLICY_HOST_TARGET` and must be inside the zone. Customers point `mta-sts.<their domain>` at it with a DNS-only CNAME.
3. **Declare the one route in the hosted deploy config** (your `wrangler.local.jsonc`, not the tracked `wrangler.jsonc`, which self-hosters deploy):
   ```jsonc
   "routes": [
     { "pattern": "*/.well-known/mta-sts.txt", "zone_name": "readysetmail.com" }
     // …and the routes the hosted service already has
   ]
   ```
   The pattern is `POLICY_ROUTE_PATTERN` in `src/mta-sts/policy-host.ts`. It matches that one path on every hostname that enters the zone, custom hostnames included (Cloudflare: "The `*/*` route pattern matches all traffic entering your zone, including traffic from custom hostnames", and "More specific routes take precedence over wildcard routes"; [Workers as the fallback origin](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/worker-as-origin/)), so it needs no route per customer. **Why it is declared, and not made through the API:** Cloudflare's deprecations page says "Cloudflare dashboard-defined routes will not be added alongside Wrangler-defined routes" and that when both exist only the routes in the Wrangler config are valid ([Wrangler deprecations](https://developers.cloudflare.com/workers/wrangler/deprecations/)). A route created through the API therefore disappears at the next `wrangler deploy` of a config that declares routes, and every policy host stops answering with it. Do not add this route to the tracked `wrangler.jsonc`. Do not add a `*/*` route to this zone either.
4. **The token** `POLICY_HOST_TOKEN` (`wrangler secret put POLICY_HOST_TOKEN`): this one zone, **Zone: Read** (finds the zone by name), **SSL and Certificates: Edit** (create, refresh and delete custom hostnames) and **Workers Routes: Edit**. Enabling a domain no longer creates a route, but Workers Routes still has to be writable: the reconcile re-creates the declared route when a deploy lost it, and removes a per-domain route an earlier build made. The client refuses everything else (`operatorPolicy`): no DNS record, no other zone, no other path. It is separate from `HOSTED_RECORDS_TOKEN` and from every customer credential.
5. **Variables:** `POLICY_HOST_ZONE`, `POLICY_HOST_TARGET`, optionally `MAX_POLICY_HOSTS` (default 100) and `SUBREQUEST_LIMIT` (default 10,000, Workers Paid). With `MODE=saas`, `SAAS_ENABLED=1` and `INTAKE_DOMAIN`, `GET /api/hosted/config` says `mta_sts: true`.
6. **Email Routing:** `tls-rpt@<INTAKE_DOMAIN>` must be routed to this Worker, as `rua@<INTAKE_DOMAIN>` is. **Reports for every customer** need `HOSTED_CONNECT_REPORTS=all`.
7. **Receiver authentication:** `AUTHSERV_ID` and `AUTHSERV_HEADER` must be set (the DMARC reports need them too), or no TLS report is authenticated and no domain can enforce.

**After every deploy** (a deploy is the one thing that can lose the route)

1. `wrangler deploy` (or `npm run deploy`).
2. Trigger the reconcile: `POST /api/instance/mta-sts/reconcile` as the instance owner (`curl -X POST -H "Authorization: Bearer <owner API key>" https://<your host>/api/instance/mta-sts/reconcile`). It does what the 11:00 UTC job does for MTA-STS, within the same subrequest budget, and answers `{ ok, visited, changed, errors, removed, served, not_served }`.
3. Confirm `not_served` is 0 (or each domain's page says "Served at ..."), and that the log has no line saying the declared route "was missing from" the zone. If it does, the deploy config lacks the route (step 3 above): fix it, deploy again.

**Safest live order**

1. Dogfood `readysetmail.com` first: turn MTA-STS on for it (it needs no custom hostname: a proxied CNAME to the target), wait until the page says "Served at ...".
2. Redeploy. Run the reconcile. Confirm the route survived (no "was missing" log line) and the fetch still passes: `curl -si https://mta-sts.readysetmail.com/.well-known/mta-sts.txt` answers 200 `text/plain` with the policy.
3. Only then turn it on for one outside domain, with a customer who knows.

**What can go wrong, and what the operator sees**

- **A custom hostname that does not validate for 7 days** is deleted by Cloudflare: its status goes to "Moved" when it is not active after the validation backoff or no longer points at the fallback origin, and a hostname "Moved" for more than seven days is deleted ([validation status](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/hostname-validation/validation-status/)). The reconcile refreshes a "moved" hostname (back to pending) and re-creates a deleted one; a setup that is still not finished 7 days after it was turned on is stopped, so a slot is never held by an abandoned setup.
- **CAA.** A customer who already has CAA records on the domain must allow the certificate authorities Cloudflare uses: when it has CAA records, "ask your customer to remove the existing CAA records or add the missing CAA record" ([CAA records](https://developers.cloudflare.com/ssl/edge-certificates/caa-records/)); the authorities named there are `pki.goog`, `letsencrypt.org`, `ssl.com` and `sectigo.com` (the list "is not exhaustive"), and a CAA record on the CNAME target applies too. Before enabling a domain, ask for its CAA records (`dig CAA <domain>`). When Cloudflare reports a CAA error for the custom hostname, the page says so in one sentence; otherwise it stays in this documentation.
- **Reports without a DKIM signature are ignored** for enforce (RFC 8460 section 3). If a customer says "no report ever arrives" check `GET /api/instance/intake-status` (is the receiving server's authentication seen?) before anything else.
- **A policy that cannot be fetched** keeps the `_mta-sts` id unpublished and the page says so. The usual reasons: the customer's CNAME does not point at `POLICY_HOST_TARGET`, the certificate is not active yet, or the declared route is missing.

**Cost.** Cloudflare for SaaS includes **100 custom hostnames** on the Free, Pro and Business plans and charges **$0.10 for each additional hostname** ([plans](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/)). One hostname is one customer domain with MTA-STS on (and one whose policy is still retiring). `MAX_POLICY_HOSTS` (default 100) is the instance-wide ceiling: over it a workspace is told "This service has reached its limit of 100 MTA-STS policy hosts." Raising it, and what to charge for it, are the operator's decisions.

**The operator's own domain** (the zone apex) needs no custom hostname: a proxied CNAME to the target does it (the declared route covers it), and a custom hostname is never created inside `POLICY_HOST_ZONE`. A name below the operator's zone (`mail.<zone>`) cannot use MTA-STS: Universal SSL does not cover it and it may not be a custom hostname either.

**The daily job** (hosted: the 11:00 UTC job; self-host: the 08:00 job) first reconciles every enabled domain, oldest check first (the custom hostname exists and is not moved, the declared route is in the zone, the policy fetch passes), then moves setup forward, reads the MX hosts (a DNS error changes nothing; no MX at all never changes the policy), stops setups older than 7 days, finishes the policies whose retirement is over, and, hosted, removes custom hostnames no domain owns. **Budget:** a Workers invocation may make 10,000 subrequests on Workers Paid and 50 on Workers Free, and a D1 statement counts as one ([limits](https://developers.cloudflare.com/workers/platform/limits/)). One run uses at most half of `SUBREQUEST_LIMIT` (default 10,000): 100 domains (25 subrequests each, measured at about 16) plus a reserve of 600, so every domain is visited at least daily up to 100 hosts, and at least every ceil(domains / 100) days beyond (a Workers Free install sets `SUBREQUEST_LIMIT=50` and gets one domain a run). The owner's reconcile endpoint has the same bound: call it again for the next oldest. A row stuck in "creating" for ten minutes (a crashed request) is torn down with whatever ids it stored.

## Self-host

The same page and the same three records, with the Worker's own host as the policy server: a **proxied** CNAME in the same Cloudflare account (Universal SSL covers `mta-sts.<domain>`), written through `CLOUDFLARE_API_TOKEN` or a connection that reaches the zone, with TLS reports to `tls-rpt@<reports domain>`. There is no operator zone, no gate, no ceiling and no route to declare. Without a Cloudflare connection that reaches the domain's zone the page says so: there is no way to give `mta-sts.<domain>` a certificate from a workers.dev address, so by-hand setup is a hosted-only path.

Two things differ from before: **enforce needs `AUTHSERV_ID` and `AUTHSERV_HEADER`** (without them nothing is authenticated, so no TLS report counts and the page says why; testing, the records and the report list work as before). The tracked `wrangler.jsonc` is unchanged (assets routing as before); see [docs/self-hosting.md](self-hosting.md). The proof of "served" is the fetch of the policy address through your own CNAME; set `SUBREQUEST_LIMIT=50` on a Workers Free plan.

## Limits

- A domain with hosted records cannot use MTA-STS (its `_smtp._tls` record is already a pointer to the hosted TLS-RPT record), and a domain with MTA-STS cannot enable hosted records.
- A name inside the operator's own zone, other than the apex, cannot use it (above).
- Enforce needs a counted report, so a server that cannot authenticate mail (`AUTHSERV_*` unset) cannot enforce.
- Re-enabling after turning off: records at the three names that are not exactly ours (for example one you changed and Ready Set Mail therefore kept) block turning it on again until you remove or fix them; the page names the record.
- DNS answers are cached, so a record you just deleted can still be seen for a few minutes.
- Enforce needs evidence: a domain that receives little mail from big senders may wait a long time for it.
- The Worker cannot test your mail server itself. Reports are the evidence; a sender that does not support MTA-STS never reports.
