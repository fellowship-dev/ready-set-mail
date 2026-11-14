# Migrations and upgrading

**Short version:** run `npm run migrate` **before** the new Worker serves traffic. `npm run deploy` does this for you.

```sh
git pull && npm install && npm run deploy   # builds, runs `npm run migrate`, then deploys
```

`npm run migrate` on its own runs `wrangler d1 migrations apply DB --remote` against the installation in `wrangler.local.jsonc`
(written by `npm run setup`; see [docs/self-hosting.md](../../docs/self-hosting.md)).

Local dev database: `npm run migrate:local`.

## Reports connected at

Migration `0011_reports_connected_at.sql` is additive: one nullable `domains.reports_connected_at` column, set when a hosted domain's reports are connected to the fixed report address and cleared when they are disconnected. Apply it before serving the new Worker (the schema guard requires it). Existing rows stay NULL.
## DMARC enforcement level

Migration `0012_dmarc_enforcement.sql` is additive: nullable `domains.dmarc_p`, `domains.dmarc_sp` and `domains.dmarc_rua` columns (the governing DMARC record's p=, sp= and whether it sends reports here); the existing `domains.dmarc_pct` column is now written by each DNS check. Apply it before serving the new Worker (the schema guard requires it). Until a domain is read from DNS again its enforcement level is shown as not known yet.

## Settled claims

Migration `0009_claim_settled.sql` is additive: two nullable `domain_claims` columns (`settled_at`, `settled_domain_id`). Apply it before serving the new Worker (the schema guard requires it). Existing claims stay open.

## Intake hardening (0010)

Migration `0010_intake_hardening.sql` is additive: nullable `aggregate_reports` columns (`ingest_token`, `record_count`, `reporter_auth_reason`, `reporter_tier`, `reporter_known_as`, `reporter_identity`), the tables `intake_quota`, `workspace_storage` (separate counted and uncounted record counters), `intake_failures`, `intake_drops` and `reporter_candidate_days`, and indexes. Apply it before serving the new Worker (the schema guard requires it; `0009` and any other lower-numbered migration are applied first, in name order). Existing reports keep working. **Behaviour change:** report ids are stored as `<reporter identity>|<id>` for every new report; older plain ids are still recognised as duplicates. Rows stored before this migration have `reporter_tier` NULL and **stop counting in `registry` mode** (no hosted report exists yet, so nothing is lost there; self-host keeps `REPORT_COUNTING=all`). Also: on `MODE=saas` only reports from a known reporter whose email authenticated (`reporter_tier = 'counted'`) feed the numbers (`REPORT_COUNTING=registry`); self-host keeps counting everything (`REPORT_COUNTING=all`). `workspace_storage` is filled by the daily retention job (5 workspaces per run) for data stored before this migration.

## DNS check time

Migration `0008_dns_checked_at.sql` is additive: one nullable `domains.dns_checked_at` column. Apply it before serving the new Worker (the schema guard requires it). Existing domains stay NULL ("Not checked yet" on the overview) until the next daily cron or a visit to the domain's setup page reads their DNS.

## Access and metrics upgrade

Migrations `0006_access_grants.sql` and `0007_metrics.sql` are additive. Apply them before serving the new Worker. `0006` revokes legacy broad `api_keys` while preserving their rows, existing users/memberships, domains and report history; it adds products, mappings, principals, grants and hashed credentials. `0007` adds Google connection/observation storage. This upgrade does not require a data reset.

Existing owners sign in and issue replacement finite product/domain/action grants and one-time `ias_…` credentials through Settings. Old `ia_…` keys and `API_KEY` environment authority no longer authenticate. Test each integration's permitted report and sibling-resource denial before declaring the conversion complete. See [agent operations](../../docs/agent-operations.md#upgrade-from-broad-prelaunch-keys) for namespace/origin setup, private bootstrap custody and rotation. Do not use the historical pre-baseline boundary below as a reason to recreate a current database.

## Installs from v1.2.0 and earlier cannot be upgraded in place

On 2026-10-22 the migration history was **squashed into a single baseline** (`migrations/0001_baseline.sql`), and the tenant
concept was renamed from "account" to **workspace** in the same change (`workspaces`, `workspace_id`, `ws_default`). The
v1.2.0 release (March 2026) and earlier recorded different migration files in `d1_migrations` (`0001_initial.sql` to
`0004_monitor_subscriptions.sql`) and changed further tables from the Worker at runtime (`src/db/migrate.ts`, since removed).
Running `npm run migrate` against such a database would try to apply the new baseline on top of the old tables and fail; there
is no adoption or repair step that converts one into the other.

To move a v1.x installation to the current release:

1. Keep the old Worker running and export its database: `npx wrangler d1 export <old database name> --remote --output v1-backup.sql`.
   Keep that file: it is the only copy of the old report history once you remove the old installation.
2. Install the current release next to it under a new name: `npm run setup -- --name <new name>`.
3. Become the owner of the new instance, add your domains again, and point each domain's DMARC `rua` at the new reports address.
4. When reports arrive at the new instance, remove the old Worker and database.

Report history from v1.x is not imported into the new database automatically; the export keeps it readable with any SQLite tool.

`migrations/0001_baseline.sql` creates the complete original schema (later files are additive; see each file) and the implicit workspace `ws_default`.

## How it works

* `wrangler d1 migrations apply` runs the unapplied files in `/migrations` in name order, each in one transaction, and records
  them by file name in `d1_migrations`. `npm run migrate` is a thin wrapper around it.
* The Worker never changes the schema. On startup it checks that `REQUIRED_MIGRATION` (`src/ready.ts`: the newest migration
  this build depends on) is recorded in `d1_migrations`; if not it answers `503` with "Database schema is out of date … run
  `npm run migrate`" (cron and email handlers log the same message).
* `test/schema-drift.test.ts` and `test/drizzle-baseline.test.ts` fail if `src/schema.ts` and `/migrations` disagree.

## Adding a migration

See [SCHEMA.md](SCHEMA.md#3-changing-the-schema). Never edit a released migration; add a new numbered file and bump `REQUIRED_MIGRATION`.
Prefer additive changes (new tables, nullable or defaulted columns) so the old Worker keeps running while you migrate.

## Rollback

Take a backup first: `npm run wrangler -- d1 export DB --remote --output backup.sql`. The old Worker may not run against a newer
schema, so roll back by restoring the backup together with the previous Worker version.

## Requirements

* A Node version supported by the root `package.json` engines (22.22.2+, 24.15.0+ on the 24 line, or 26+).
* `wrangler` ≥ 4.
