-- 0013: what a hosted account accepted at sign-up.
--
-- The sign-up form shows "By creating an account you agree to the Terms and the Privacy Policy." The acceptance is recorded
-- when the emailed code proves the address (never before): when, and which terms (TERMS_VERSION, else the terms URL).
-- Additive and nullable: accounts created before this, self-hosted accounts and accounts confirmed by a password reset hold NULL.
ALTER TABLE users ADD COLUMN terms_accepted_at INTEGER;
ALTER TABLE users ADD COLUMN terms_version TEXT;
