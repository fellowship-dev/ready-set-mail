# MTA-STS

How Ready Set Mail turns on MTA-STS for a domain, on the hosted service and on a self-hosted install, what it writes, when it lets you enforce, how it comes off again and what the operator sets up. The decision record is [ADR 0015](adr/0015-mta-sts-customer-zone-records-and-saas-policy-host.md); the API is under [MTA-STS in docs/hosted.md](hosted.md#mta-sts).

## What it is, in plain words

Email between mail servers is encrypted only if both sides agree to it, and a person in the middle can make them not agree. MTA-STS (RFC 8461) is a promise a domain publishes: "when you deliver mail to me, use an encrypted connection (TLS) to one of these mail servers (the MX hosts), or tell me it failed." Senders that support it (Gmail, Microsoft and most large providers do) read the promise, and then send you a daily **TLS report** about how their deliveries went. The promise has two modes: **testing** (senders deliver as before and report problems; nothing is rejected) and **enforce** (a sender that cannot use an encrypted connection to your servers does not deliver).

## What you get

One page per domain, `/#/domains/:id/mta-sts`, opened from the MTA-STS card under "DNS tools" on the domain page. That section stays hidden when neither tool is available nor set up (a hosted service without policy hosting configured shows no MTA-STS card at all), and its one-line summary names only the tools listed. The card says the real state in a word: **Off**, **Setting up**, **Testing**, **Enforced**, or **Not available** with a short reason.

- **Before it is on:** one sentence of what it is, the MX hosts found now, the exact records (names and values) that turning it on writes, and one action, **Turn on in testing mode**. If there are no MX records, or the lookup failed, the page says which (they are not the same) and offers no action. If it cannot be turned on, the page says why in one sentence and offers no button.
- **While it sets up:** the setup checks in words (In place, Waiting, Not found yet, Wrong, Couldn't check), the records still to add by hand, and **Check now**. The page also looks again by itself every 30 seconds for half an hour.
- **Once it is on:** the mode, the MX hosts the policy lists, the policy address, the TLS reports of the last 30 days (who sent each, which days, successful and failed sessions, the failure types in plain words), **Switch to enforce** (disabled, with the reasons listed, until it is safe), and **Turn off MTA-STS**.
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

Served by this Worker at `https://mta-sts.<domain>/.well-known/mta-sts.txt`, never cached, and nothing else is served on an `mta-sts.*` hostname (every other path is a 404). The `mx:` lines are the MX hosts found when it was turned on and at each daily check; a changed list gets a new id. `max_age` is how long senders may keep the policy: **one day, in both modes**, so a mistake or an MX change heals within a day. RFC 8461 section 3.2 says "weeks or greater" is typical; that is an expectation, not a requirement, and raising it for enforce is the operator's decision.

## Testing, then enforce

It always starts in testing: the page offers no choice. **Switch to enforce** is enabled only when all of this holds (`enforceReadiness` in `src/mta-sts/evidence.ts`), and the page lists every rule that does not:

- setup is finished: the policy server and the three records are confirmed;
- it has been in testing for at least **7 days**, so senders have had time to report;
- at least one TLS report ended after the current policy id was published, with successful MTA-STS sessions (reports also count DANE sessions; only the MTA-STS ones count here);
- none of these failures in the last 14 days: `certificate-host-mismatch`, `certificate-expired`, `certificate-not-trusted`, `starttls-not-supported`, `validation-failure`, `sts-policy-fetch-error`, `sts-policy-invalid`, `sts-webpki-invalid`; and no report that counts failures without saying why;
- every MX host is a name (not an address) that matches the policy's `mx:` list.

Why: in enforce mode a sender that cannot use TLS to your server drops the mail. The reports are the only evidence that your servers' certificates are valid for the names in the MX records, because the Worker cannot connect to a mail server itself (Cloudflare Workers cannot open outbound connections on port 25). **Switch to testing** is always allowed. If the MX list **grows** while enforcing, the mode goes back to testing at the next daily check (the new hosts have no TLS evidence) and a notice says so.

## Turning off, and max_age

**Turn off MTA-STS** is offered only in testing, and only once senders that fetched an enforce policy no longer hold it: from enforce the page says "Switch to testing first. Senders keep the enforce policy for up to 1 day; you can disable it after that." (the time is `max_age` after the switch back). Turning off removes exactly what was made: the records Ready Set Mail wrote, by id (a record you changed since is **kept**, and the result lists it with the reason), and on the hosted service the custom hostname and Worker route. Then it says how long senders that already fetched the policy may keep it (up to `max_age`, now one day). Records you added by hand stay until you delete them.

Removing a domain, losing its ownership proof, or another workspace taking the name over (an eviction) does the same, best effort, at once. An eviction cannot reach the evicted workspace's own DNS records any more (its connection no longer covers the name), so those stay and are listed in that workspace's audit log as kept.

## TLS reports, and where they show

Senders send them to `tls-rpt@<INTAKE_DOMAIN>` (hosted) or the workspace's reports domain (self-host). On the hosted service one shared address serves everyone: the report names its domain in `policies[].policy.policy-domain`, the intake reads only that field from the start of the report, and files it under the workspace that owns the domain by the one proven-owner rule, if that domain has MTA-STS on and the workspace is admitted to reports (`HOSTED_CONNECT_REPORTS`). Every policy in the report must be covered by that domain, or nothing is stored. Each stored report keeps the sessions under MTA-STS policies apart from the rest, with the distinct failure types.

They show on the MTA-STS page (last 30 days) and, as the sessions under your MTA-STS policy, in the domain's health report ("TLS report history") once MTA-STS is on and set up. Senders usually send one report a day after they deliver mail to you; until then the page says so.

## The hosted operator's setup

MTA-STS needs a certificate for `mta-sts.<customer domain>`, a name in a customer's zone, in another Cloudflare account. The only way the operator's Worker can answer HTTPS for it is **Cloudflare for SaaS**: a custom hostname per customer domain in the operator's zone, validated over HTTP once the customer's CNAME resolves, with a Worker route sending that hostname to this Worker ([Cloudflare for SaaS: getting started](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/getting-started/), [Workers as the fallback origin](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/worker-as-origin/)).

1. **Enable Cloudflare for SaaS** on the zone (`POLICY_HOST_ZONE`, for example `readysetmail.com`: Custom Hostnames).
2. **Create the target:** a proxied, originless record inside that zone, for example `mta-sts-host.readysetmail.com AAAA 100::` (proxied). Set it as the zone's **fallback origin** and wait until Cloudflare says Active. This is `POLICY_HOST_TARGET`, and it must be inside the zone. Customers point `mta-sts.<their domain>` at it with a DNS-only CNAME.
3. **No `*/*` Worker route** on that zone that would send the zone's own traffic to this Worker. The product creates one route per customer hostname (`mta-sts.<domain>/*`) and deletes it again.
4. **Create a token** for that one zone with **Zone: Read** (to find the zone by name), **SSL and Certificates: Edit** (custom hostnames) and **Workers Routes: Edit**. This is the secret `POLICY_HOST_TOKEN` (`wrangler secret put POLICY_HOST_TOKEN`). It is separate from `HOSTED_RECORDS_TOKEN` and from every customer credential, and the client refuses anything but creating and deleting custom hostnames and Worker routes of that zone (`operatorPolicy` in `src/mta-sts/policy-host.ts`); it never writes a DNS record.
5. **Set the variables** (`wrangler.jsonc` `vars`): `POLICY_HOST_ZONE`, `POLICY_HOST_TARGET`, and optionally `MAX_POLICY_HOSTS`. Together with `MODE=saas`, `SAAS_ENABLED=1` and `INTAKE_DOMAIN`, `GET /api/hosted/config` then says `mta_sts: true`.
6. **Email Routing:** the address `tls-rpt@<INTAKE_DOMAIN>` must be routed to this Worker, as `rua@<INTAKE_DOMAIN>` is ([docs/hosted.md](hosted.md#2-email-routing-inbound)).
7. **Reports for every customer** need `HOSTED_CONNECT_REPORTS=all`; with the default `owner`, only the operator's own workspaces can use MTA-STS (the others are told it is not open to them yet).

**Cost.** Cloudflare for SaaS includes **100 custom hostnames** on the Free, Pro and Business plans and charges **$0.10 for each additional hostname** ([plans](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/)). One hostname is one customer domain with MTA-STS on. `MAX_POLICY_HOSTS` (default 100) is the instance-wide ceiling: over it a workspace is told "This service has reached its limit of 100 MTA-STS policy hosts." Raising it, and what to charge for it, are the operator's decisions.

**The operator's own domain** (the zone apex) needs no custom hostname: a proxied CNAME to the target and a Worker route do it, and a custom hostname is never created inside `POLICY_HOST_ZONE`. A name below the operator's zone (`mail.<zone>`) cannot use MTA-STS: Universal SSL does not cover it and it may not be a custom hostname either.

**The daily job** (hosted: the 11:00 UTC job; self-host: the 08:00 job) looks at every enabled domain, oldest check first, at most 100 a run, five at a time: moves setup forward, reads the MX hosts (a DNS error changes nothing; no MX at all never changes the policy), and, hosted, removes custom hostnames and routes this product made that no domain owns (at most 20 a run). A row stuck in "creating" for ten minutes (a crashed request) is torn down with whatever ids it stored.

## Self-host

The same page and the same three records, with the Worker's own host as the policy server: a **proxied** CNAME in the same Cloudflare account (Universal SSL covers `mta-sts.<domain>`), written through `CLOUDFLARE_API_TOKEN` or a connection that reaches the zone, with TLS reports to `tls-rpt@<reports domain>`. There is no operator zone, no gate and no ceiling. Without a Cloudflare connection that reaches the domain's zone the page says so: there is no way to give `mta-sts.<domain>` a certificate from a workers.dev address, so by-hand setup is a hosted-only path.

## Limits

- A domain with hosted records cannot use MTA-STS (its `_smtp._tls` record is already a pointer to the hosted TLS-RPT record), and a domain with MTA-STS cannot enable hosted records.
- A name inside the operator's own zone, other than the apex, cannot use it (above).
- Re-enabling after turning off: records at the three names that are not exactly ours (for example one you changed and Ready Set Mail therefore kept) block turning it on again until you remove or fix them; the page names the record.
- DNS answers are cached, so a record you just deleted can still be seen for a few minutes.
- Enforce needs evidence: a domain that receives little mail from big senders may wait a long time for it.
- The Worker cannot test your mail server itself. Reports are the evidence; a sender that does not support MTA-STS never reports.
