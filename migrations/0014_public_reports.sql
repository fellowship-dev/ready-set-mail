-- Public, dated free-check reports: what public DNS showed for one domain at one moment, at a private link
-- (https://readysetmail.com/r/<id>). Anyone with the link can read the report; it is not tied to any workspace. Additive only.
-- Numbered 0014: 0013 is taken by another change. Kept until deleted: there is no expiry job (docs/data-retention.md).
--
-- id                 128 random bits, base64url (22 characters). The link is the only way to find a report.
-- domain             the checked domain, as normalised by the checker (the only thing the visitor supplies).
-- created_at         unix seconds when the check ran; the report's date.
-- schema_version     shape of result_json (1: the checker's DMARC, SPF and DKIM results, src/public-reports/types.ts).
-- source             which checker made it: dmarc, spf or dkim (a fixed word, never input).
-- result_json        the stored result, at most 64 KiB, never changed after insert.
-- delete_token_hash  SHA-256 (hex) of the delete token handed out once at creation; the token itself is not stored.
-- dedupe_key         keyed hash of the client IP and the domain, so a repeat within a minute returns the same report;
--                    cleared once that minute has passed, so it does not outlive its purpose.
CREATE TABLE public_reports (
  id TEXT PRIMARY KEY NOT NULL,
  domain TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  source TEXT NOT NULL,
  result_json TEXT NOT NULL,
  delete_token_hash TEXT NOT NULL,
  dedupe_key TEXT
);
CREATE INDEX idx_public_reports_created ON public_reports (created_at);
CREATE INDEX idx_public_reports_dedupe ON public_reports (dedupe_key);
