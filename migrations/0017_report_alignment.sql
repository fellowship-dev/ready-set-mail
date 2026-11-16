-- What the receiver decided about alignment, kept per record, so every message that failed DMARC can be attributed.
--
-- report_records.spf_aligned / dkim_aligned
--     The record's policy_evaluated spf / dkim: 1 aligned (pass), 0 not aligned (fail). NULL: stored before this column.
--     A message fails DMARC when neither is 1. The raw results (spf_result, dkim_result) say what SPF and DKIM
--     verified, not whether they align with the From domain, so a message whose raw results both pass can still fail DMARC
--     (RFC 9989 section 3.2.10; RFC 9990 section 3.1.1.10-13). Only the receiver knows its verdict (local policy, a second
--     signature, the record's alignment mode), so it is kept as reported instead of being recomputed.
-- aggregate_reports.aspf / adkim
--     The alignment modes of the policy the receiver applied (policy_published: 'r' relaxed, 's' strict). NULL: not stored.
--     They say WHY an identifier did not align: strict needs the identical domain, relaxed the same organizational domain.
ALTER TABLE report_records ADD COLUMN spf_aligned INTEGER;
ALTER TABLE report_records ADD COLUMN dkim_aligned INTEGER;
ALTER TABLE aggregate_reports ADD COLUMN aspf TEXT;
ALTER TABLE aggregate_reports ADD COLUMN adkim TEXT;
