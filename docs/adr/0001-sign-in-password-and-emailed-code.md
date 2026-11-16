---
status: accepted
date: 2026-11-15
decided-by: owner
---
# Hosted sign-in is a password plus a 6-digit emailed code, limited by daily caps

On the hosted service people sign in with a password and then a 6-digit code sent by email, and sign-up, password reset and invite acceptance end with the same code; wrong codes and code mails are limited per hour and per day. A self-hosted install asks a person for the code only once mail is known to reach them (after they entered one code), and its operator can turn codes off (`SIGNIN_CODES=off`). When guessing needed limiting, we chose daily caps over longer or mixed-character codes. Owner decision, 2026-11-15: "Password + code"; "Daily limit is preferred over using a separate type of char/code".

**Consequences**
- Every code everywhere stays 6 digits: `CODE_LENGTH` in `src/auth/codes.ts`. Limits are the constants next to it (`SIGNIN_FAILS_PER_DAY`, `OPEN_FAILS_PER_DAY`, `CODE_MAIL_CAPS`).
- A new code format, or a sign-in without the code, needs a new ADR.
