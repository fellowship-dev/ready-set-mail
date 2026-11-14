-- The DMARC record that governs a domain, read with its policy, so every page can say what is in force and what to change:
-- full enforcement versus partial, which tag sets a subdomain's policy, and whether reports reach this dashboard.
-- Additive and nullable. Existing rows stay NULL until their next DNS read: until then the enforcement detail is shown as
-- not re-checked yet instead of calling a domain enforced. (Numbered 0012: 0010 and 0011 are report intake.)
--
-- The governing record is the domain's own _dmarc record, else its organizational domain's (RFC 7489 6.6.3).
-- dmarc_p    p= of the governing record, lower-cased. NULL: no usable record, or not read since this migration.
-- dmarc_sp   sp= of the governing record as written, lower-cased. NULL: the record has no sp= tag (or see dmarc_p).
-- dmarc_rua  1 when the governing record's rua= names this domain's reports address, 0 when it does not; NULL when
--            not read since this migration. Only the comparison is stored, never the addresses.
-- The existing nullable domains.dmarc_pct column (never written for domains before) now holds pct= from the same read
-- (100 when the record has no pct= tag).
ALTER TABLE domains ADD COLUMN dmarc_sp TEXT;
ALTER TABLE domains ADD COLUMN dmarc_p TEXT;
ALTER TABLE domains ADD COLUMN dmarc_rua INTEGER;
