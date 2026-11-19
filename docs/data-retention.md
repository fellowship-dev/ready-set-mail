# Data retention and deletion

What Ready Set Mail keeps, for how long, and how it goes away. This is the page the privacy policy and the DPA cite: if a window changes
here, the policy changes with it. The windows are enforced by a daily job (`src/lifecycle/retention.ts`), not by convention.

## Retention windows

Defaults apply when the variable is unset. Values are whole days; a value that is not a positive whole number is ignored and the default is used
(so a typo can never switch a window off).

| Data | Kept for | Variable | Notes |
|---|---|---|---|
| Aggregate report rows and their records (`aggregate_reports`, `report_records`) | **13 months** (395 days after the report period ended) | `RETENTION_REPORTS_DAYS` | Year-over-year trends need 13 months. Each record also keeps the receiver's own alignment verdict (`spf_aligned`, `dkim_aligned`) and each report the alignment modes it applied (`aspf`, `adkim`): they are columns of those rows and go with them. |
| TLS-RPT reports | **13 months** (395 days) | `RETENTION_TLS_DAYS` | |
| Raw report XML (and the raw JSON of TLS-RPT reports) | **30 days** self-hosted; **not stored** in hosted mode | `RAW_XML_RETENTION_DAYS` | `0` = never store. The parsed rows above are what the raw payload contained. After the window only the raw payload is removed. Hosted mode defaults to `0`. |
| IP enrichment cache (`ip_info`: reverse DNS, ASN, organisation, country) | **30 days** | `RETENTION_IP_INFO_DAYS` | A global cache, not per workspace. |
| Free-check results (`check_results`) | **30 days** | `RETENTION_CHECK_RESULTS_DAYS` | |
| Public domain reports (`public_reports`: the checked domain, the time and what public DNS showed) | **until deleted** | | No automatic expiry, by decision, within a total storage budget (1 GiB by default, `PUBLIC_REPORTS_TOTAL_BYTES`; below). Deleted with the report's delete token or by the operator on request (below). Not tied to a workspace. |
| Rate-limit counters (`auth_rate_limits`: sign-in and public reports, keyed by a keyed hash; for public reports the hash key changes every UTC day) | **about 2 days** after their window ends | | Swept now and then on writes and by the daily job. A counter, no address. |
| Intake counters (`intake_usage`, `intake_quota`: messages and records per address, workspace and day) | **8 days** | `RETENTION_INTAKE_COUNTERS_DAYS` | Counters, no report content. |
| "Reports we could not store" markers (`intake_failures`: a count per domain, day and reason) | **90 days** | `RETENTION_INTAKE_FAILURES_DAYS` | A counter, no report content. |
| Aggregate reports that are stored but never counted (`reporter_tier` `unknown` or `unauthenticated`) | **30 days** | `RETENTION_UNCOUNTED_REPORTS_DAYS` (the earlier name `RETENTION_UNAUTHENTICATED_REPORTS_DAYS` is still honoured when it is unset) | Stored but never counted. Not applied when `REPORT_COUNTING=all`, where they are the numbers. A reporter an owner later promotes becomes `counted` and keeps the normal window. |
| Authenticated senders not in the known-reporter registry (`reporter_candidate_days`: DKIM organisation, From domain, report email, counts per day) | **90 days** | | Instance-wide, no report content, no customer or address. |
| Sessions | until they expire (sessions last 30 days) | | Includes the IP address and user agent stored with the session. |
| Sign-in code attempts (code hash, password hash typed at sign-up, and the "about you" answers typed on the second sign-up screen) | 10 minutes; deleted when used or replaced, expired rows swept | | The answers (name, organization, whose email, optional role and where they heard about us) end with the attempt unless its code is right. |
| Sign-up profile (`account-profile:<user id>` in `verifications`: the same answers, kept for the account) | until the account is deleted | | Deleted with the account. |
| Hand-off records (`invite-handoff:<invite token>`: workspace, domain name, who asked, where the invitation went) | **30 days** after they are sent | | Swept as expired `verifications` rows. |
| Invites | **30 days after they expire** (used or not) | `RETENTION_INVITES_DAYS` | |
| Audit log | **12 months** (365 days) | `RETENTION_AUDIT_DAYS` | |
| Expired canary (free-check) tokens | 1 day after they expire | | Existing rule, in the hosted daily job. |
| Billing orders (`billing_orders`: workspace id and name, domain, buyer's email, amount, Stripe ids, status and dates) | **7 years** from creation, then deleted by the daily job; kept when the workspace or domain is deleted | | Accounting records, see [Billing records](#billing-records). |
| Lifecycle email records (hosted: `email_preferences` a person's choices per workspace; `lifecycle_sends` which lifecycle email was claimed or sent to whom and when, no address and no content; `domain_milestones` when a domain's records were first seen live) | while the workspace exists; a person's preference rows go when they leave the workspace; all three go with the workspace | | `lifecycle_sends` is what keeps an email from being sent twice, so it is kept as long as the workspace is. Choices are in the workspace export. |
| Stripe event ledger (`billing_events`: event id, type, outcome; no payload) | **90 days** | | Webhook idempotency only. |
| Apps that registered themselves and were never approved | **24 hours** (`MCP_DCR_UNUSED_HOURS`) | `MCP_DCR_UNUSED_HOURS` | Deleted by the next registrations and the daily job. See [agent operations](agent-operations.md#letting-apps-register-themselves). |
| Agent connections that ended (revoked, or past their end date) | **7 days** after they ended, then the record, its principal and grants, and the registered app when no record of it remains | | Daily job. The audit log keeps who approved, revoked and what was removed for its own 12 months. |
| Used agent refresh tokens (`refresh_rotations`: the hash of the token, the time, the answer sealed under the token) | **30 days** after first use (a refresh token's life) | | Daily job. Only the 30 seconds after first use are ever read. |
| Failed Cloudflare revocations of deleted workspaces | retried daily until they succeed, at most **30 days** | | See below. The sealed token is deleted with the row; giving up is logged and written to the audit log. |

Backups: deleted data can remain in Cloudflare D1 Time Travel restore points until they roll off. Check the retention of your D1 plan; we state
"within 30 days" for hosted deletions.

Not covered by this job: data held by other parties (Cloudflare, Stripe, Vercel, email providers) under their own terms, and the
records the privacy policy describes for the website and for sales prospecting.

## How the job works

* Runs once a day on its own cron trigger (`0 4 * * *`, so it never shares an invocation with the per-workspace jobs), over the whole database (not per workspace).
  Failed Cloudflare revocations are retried first, then the sweeps.
* Deletes in bounded batches (500 rows per statement; at most 1,000 `report_records` per statement) and issues at most **300 statements per run in total**, so D1's per-invocation query limit holds.
  A large backlog is cleared over several days. A sweep that was not finished says `<table>_truncated` in the log line.
* Report windows count from when the report ended **or** when it was received, whichever is earlier, so a report cannot extend its own life by claiming a future end date.
* After the report sweep it keeps `workspace_storage` (the records a workspace holds, which the storage cap compares against) in step with what it deleted, and recounts a few workspaces (5 per run) to repair drift.
* Idempotent: running it again deletes nothing more. Safe to re-run by hand or after a failure.
* A failing step is logged and the other steps still run.
* Logs one line per run with the counts: `[retention] {"aggregate_reports":12,"sessions":4,…,"failed":0}`.
  Read it in Workers logs; an alert on `"failed":` greater than 0 is worthwhile.
* Retention for `leads` (nothing writes them since the follow-up sequence was removed, ADR 0015; old rows are deleted 12 months after their last activity), suppression lists, unsubscribe records and the free-monitor subscriptions is owned by the onboarding feature, not by this job.

## Public domain reports

Running the website's domain checker stores a dated report (`POST /api/public/reports`, `src/public-reports/routes.ts`) that anyone with its
link (`https://readysetmail.com/r/<id>`) can read. A row holds the checked domain, when it was checked, which checker made it, and the DNS
results; no IP address, no email and nothing else the visitor typed. Only a complete check is stored: when any lookup failed or was cut
short the answer is `503` and nothing is kept. A keyed hash of the client and the domain is kept with the row so a repeat within a minute
returns the same report; it is cleared when the next report is made after that minute, and at the latest by the daily job, which clears
these keys before anything else.

* **Kept until deleted.** The daily job deletes no report; it only clears those de-duplication keys (`public_report_dedupe_keys` in its log line).
* **Deleted by its creator:** `DELETE /api/public/reports/:id` with the delete token the creation answer handed out once (the site keeps it
  in the creator's browser and shows "Delete this report"). Only its SHA-256 is stored.
* **Deleted on request** (anyone else, sent to the contact address in the privacy policy with the link): the operator runs
  `wrangler d1 execute DB --remote --command "DELETE FROM public_reports WHERE id = '<id>'"`. The id is the last part of the link. The
  storage counter catches up at the next daily job.
* **Not in a workspace export or an account deletion:** a report belongs to no workspace and no account.

### Storage budget

The reports share the database with sign-in and report intake, so they have bounds. Defaults, each overridable with a positive integer:

| Limit | Default | Setting | When it is reached |
|---|---|---|---|
| One report | 32 KiB (32,768 bytes; ordinary reports measure 6.4 to 8.4 KB) | `PUBLIC_REPORTS_MAX_REPORT_BYTES` | that report is refused (`413`) |
| New reports a UTC day | 2,000 | `PUBLIC_REPORTS_DAILY_CAP` | `429` until the next UTC day |
| New bytes a UTC day | 50 MiB (52,428,800 bytes) | `PUBLIC_REPORTS_DAILY_BYTES` | `429` until the next UTC day |
| All stored reports | 1 GiB (1,073,741,824 bytes) | `PUBLIC_REPORTS_TOTAL_BYTES` | `503` "We cannot save more reports at the moment"; existing reports keep opening and can be deleted |

At the defaults the total holds at least 32,768 reports (all at the 32 KiB maximum) and about 128,000 to 168,000 ordinary ones; the daily
byte budget allows at least 1,600 maximum-size reports a day, and the daily cap of 2,000 ordinary ones uses at most about 17 MB.

* The counters live in one row, `public_report_usage`: reports and bytes today, reports and bytes stored. A new report reserves its bytes
  in one conditional statement, so concurrent requests cannot overshoot; it is checked (read only) before the request writes anything.
  Deleting a report gives its bytes back. The daily job recounts the stored total from `public_reports`.
* **At 80% of the total** the Worker logs `[public-reports] stored reports have reached 80% of PUBLIC_REPORTS_TOTAL_BYTES` once when a
  report crosses it, and the daily job logs it every day while it holds (`public_reports_near_limit` in its log line). The instance
  preflight (`GET /api/instance/preflight`) has a `public_reports` field (stored reports and bytes, the budget, the percent used,
  `near_limit`) and a `public_reports` item from 80%.

## Billing records

Hosted billing (see [billing.md](billing.md)) keeps one row per purchase in `billing_orders`: the workspace id and a snapshot of its name, the domain name, the buyer's email, the amount and currency, the Stripe ids (customer, invoice, payment intent, charge) and the status and dates. These are **accounting records**, so they have no foreign key to the workspace or the domain and **survive deleting either**; the workspace name and domain name in the row are snapshots, taken when the order was made. They are kept for **seven years** from the order's creation (the accounting period assumed for Fellowship), then deleted by the daily job. The buyer's email is part of the accounting record and is not erased on request while it must be kept; Stripe holds its own copy under Stripe's terms. No card number, brand or last four is ever stored by Ready Set Mail (the card is read from Stripe when someone looks at Settings). The Stripe Customer is not deleted by Ready Set Mail, not even when the workspace is deleted. The binding rows of "add a card" sessions (`billing_checkout_sessions`) are deleted with the workspace and in any case after 30 days. Billing exists on the hosted service only; a self-hosted instance stores none of this.

## Product analytics (hosted)

When the hosted service has PostHog configured ([analytics.md](analytics.md)), each workspace has one random analytics id (`settings.analytics_id`) and a few one-time markers (`settings` keys starting `analytics:`, holding only a unix time, e.g. when a domain's records went live) so that "first time" steps are counted once. They are deleted with the workspace. PostHog keeps the events themselves (category and bucket properties only, under the random id) under its own retention; deleting the workspace deletes the only link between the id and the account. A self-hosted installation stores none of this.

## Deleting a workspace

`DELETE /api/workspaces/:id` (owners; `?confirm=<name>` when it has domains). In order:

1. Cloudflare is checked for every domain; if it cannot be reached nothing is deleted.
2. Each domain is deleted through the normal delete (DNS records Ready Set Mail added are removed).
3. **Every Cloudflare connection is disconnected, which revokes OAuth grants at Cloudflare.**
   If Cloudflare does not confirm a revocation the deletion still goes ahead, the failure is logged, and a *tombstone* keeps the sealed (encrypted) token
   so the daily job can retry; the tombstone is written *before* the connection is deleted, and if it cannot be written (or the connections cannot be listed) the deletion stops with `502 revoke_failed` and nothing more is removed.
   The tombstone is deleted on success, and given up after 30 days (logged and recorded in the audit log under the deleted workspace's id).
   **Pasted API tokens cannot be revoked from here**: the response says how many there were (`cloudflare.pasted_tokens`) and the owner must revoke them in the Cloudflare dashboard.
4. All workspace data is deleted, including its memberships, API keys and agent approvals. The people who belonged to it keep their accounts (ADR 0024); anyone with no other workspace lands on "No workspace yet". **Billing orders are not**: they stay as accounting records ([Billing records](#billing-records)), and the Stripe Customer is left alone.

## Deleting an account

`DELETE /api/account` with `{ "confirm": "<your email>" }` (signed-in users only, not API keys). Deletes the user, their sessions, login methods
(password and OAuth links), tokens, API keys, memberships and invites addressed to them; their email is removed from the audit log (the entries remain, without it).
Workspaces only they belong to are deleted as above, including the Cloudflare revocation.

`GET /api/account` previews it: the workspaces that would be deleted and the Cloudflare connections the user created in workspaces that stay (those keep working after the user is gone; disconnect them first if that is not wanted). Invites the user sent that are still pending are revoked.

If several workspaces are deleted and a later one fails, the error names those already deleted; the account is kept and retrying finishes the job.

Refused with `409 transfer_required` while the user is the only owner of a workspace that has other members. Transfer ownership
(`POST /api/workspaces/:id/transfer-ownership {"user_id": …}`, or Members → Make owner) or delete the workspace first.
The instance workspace of a self-hosted install is never deleted this way.

## Data export

`GET /api/workspaces/:id/export` (owners) returns everything the workspace holds as JSON: members, domains, reports and records, TLS reports, settings,
audit log, invites, API-key metadata, Cloudflare connection metadata, per-domain configuration and the workspace's billing orders (hosted). It never includes password hashes, tokens, key hashes,
sealed Cloudflare tokens, secret settings or raw report payloads. Use it to answer subject-access and portability requests.
The dashboard has a button in Settings → Danger zone.
Columns are listed explicitly (a new column is not exported until it is added to the list), and the file is streamed a page at a time. A workspace with more than 250,000 rows in its big tables is refused with `413 export_too_large`; a background export is a planned follow-up.

## Settings reference

```
RAW_XML_RETENTION_DAYS=30        # 0 = never store raw XML; hosted default 0
RETENTION_REPORTS_DAYS=395
RETENTION_TLS_DAYS=395
RETENTION_IP_INFO_DAYS=30
RETENTION_CHECK_RESULTS_DAYS=30
RETENTION_INVITES_DAYS=30
RETENTION_AUDIT_DAYS=365
```

Set them as Worker variables (`vars` in `wrangler.jsonc`).
