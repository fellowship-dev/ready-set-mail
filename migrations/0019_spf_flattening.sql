-- SPF flattening that follows providers (docs/spf-flattening.md). Additive only: ten nullable or defaulted columns on spf_flatten_config.
-- Nothing changes for a row that exists: it keeps its values, and the daily refresh fills the new ones.
--
-- revision           version for compare-and-set: +1 on every state change (turn on, refresh that wrote, turn off)
-- lease_until        unix seconds: a run holds the row until then (claim first, then write), so two runs never write twice
-- previous_record    the flattened record before the last change (one step back; shown on the domain page after a change)
-- last_attempt_at    when a run last looked at the row, whatever came of it: the queue is oldest first, and a failing row cannot hold the others back
-- last_refreshed_at  when a run last resolved the original record successfully, changed or not
-- problem_kind       null, or why the record is not being kept current (include_unresolved, too_large, macro, no_addresses, connection_lost, edited_outside, record_missing, restore_failed)
-- problem_since      when this kind of problem began; cleared when it recovers
-- last_error_at      when last_error (the one plain sentence about it) was written
-- lookups_after      lookups the flattened record needs (lookup_count stays what the original needed)
-- inline_mode        fewest (default) or most: how many includes the refresh inlines; kept so every run makes the same kind of choice
-- last_flattened_at  keeps its column and now means "when the published record last changed" (it used to be bumped by every daily run).
ALTER TABLE spf_flatten_config ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE spf_flatten_config ADD COLUMN lease_until INTEGER;
ALTER TABLE spf_flatten_config ADD COLUMN previous_record TEXT;
ALTER TABLE spf_flatten_config ADD COLUMN last_attempt_at INTEGER;
ALTER TABLE spf_flatten_config ADD COLUMN last_refreshed_at INTEGER;
ALTER TABLE spf_flatten_config ADD COLUMN problem_kind TEXT;
ALTER TABLE spf_flatten_config ADD COLUMN problem_since INTEGER;
ALTER TABLE spf_flatten_config ADD COLUMN last_error_at INTEGER;
ALTER TABLE spf_flatten_config ADD COLUMN lookups_after INTEGER;
ALTER TABLE spf_flatten_config ADD COLUMN inline_mode TEXT NOT NULL DEFAULT 'fewest';
