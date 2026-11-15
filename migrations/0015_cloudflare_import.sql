-- Cloudflare first run: auto-import of the zones a grant covers, and how each domain was proven through them. Additive only.
--
-- domains.cf_account_id  the Cloudflare account the domain's zone belongs to, when it was verified through Cloudflare (null otherwise).
-- domains.cf_zone_id     the zone it was verified through. Both are what Cloudflare said at that moment; revoking the token later does not clear them.
-- domains.verified_at    unix seconds of that proof (null for rows verified another way or before this migration).
--                        The full record (method, connection) is the `domain.proof` audit entry.
-- domains.cf_zone_name, cf_name_servers  the zone's name and the name servers Cloudflare assigned it (JSON array, sorted) that public DNS delegated
--                        it to at the proof. A rival proof of the name and the daily re-check compare public DNS with them: a domain whose zone moved
--                        away no longer matches and stops counting as proven. NULL on proofs made before they were kept.
-- domains.proof_checked_at  unix seconds the daily job last saw the delegation still matching.
-- domains.proof_lost_at  unix seconds the proof was withdrawn (verified_via became 'legacy', so intake stops accepting the domain's reports).
-- cloudflare_connection_zones.cf_account_name  the account's name as Cloudflare returned it with the zone list, so Settings can name an account
--                        without calling Cloudflare. One grant can cover several accounts: the account is a property of the zone, not of the connection.
-- removed_domains        names a person removed from the workspace. Auto-import does not add them back; they are offered as suggestions.
--                        Cleared when the name is added again. Deleted with the workspace.
ALTER TABLE domains ADD COLUMN cf_account_id TEXT;
ALTER TABLE domains ADD COLUMN cf_zone_id TEXT;
ALTER TABLE domains ADD COLUMN verified_at INTEGER;
ALTER TABLE domains ADD COLUMN cf_zone_name TEXT;
ALTER TABLE domains ADD COLUMN cf_name_servers TEXT;
ALTER TABLE domains ADD COLUMN proof_checked_at INTEGER;
ALTER TABLE domains ADD COLUMN proof_lost_at INTEGER;
ALTER TABLE cloudflare_connection_zones ADD COLUMN cf_account_name TEXT;
CREATE TABLE removed_domains (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  removed_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (workspace_id, domain)
);
