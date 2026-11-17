-- Agent refresh tokens that were used once (src/mcp/refresh-replay.ts, ADR 0022). Additive: one new table, nothing existing changes.
--
-- One row per refresh token that was used to get a new one, keyed by the SHA-256 of that token (never the token). The row is the claim: the first
-- request to insert it rotates the token; a second request with the same token inside the grace window gets the first one's answer instead of
-- ending the connection. `response` is that answer (the new tokens), encrypted with AES-GCM under a key derived from the presented refresh token,
-- so a copy of this table is useless without the token. state: pending (the rotation is running) or done (response is stored).
-- Deleted by the daily clean-up once older than the refresh token lifetime (30 days).
CREATE TABLE refresh_rotations (
  token_hash TEXT PRIMARY KEY NOT NULL,
  grant_key TEXT NOT NULL,
  first_used_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  response TEXT,
  CONSTRAINT refresh_rotations_state_check CHECK (state IN ('pending', 'done'))
);
CREATE INDEX idx_refresh_rotations_first_used ON refresh_rotations (first_used_at);
