---
status: accepted
date: 2026-11-15
decided-by: owner
---
# Sign-in is a password plus a 6-digit emailed code, limited by daily caps

People sign in with a password and then a 6-digit code sent by email; wrong codes and code mails are limited per hour and per day. When guessing needed limiting, we chose daily caps over longer or mixed-character codes. Owner decision, 2026-11-15: "Password + code"; "Daily limit is preferred over using a separate type of char/code".

**Consequences**
- Every code everywhere stays 6 digits: `CODE_LENGTH` in `src/auth/codes.ts`. Limits are the constants next to it (`SIGNIN_FAILS_PER_DAY`, `OPEN_FAILS_PER_DAY`, `CODE_MAIL_CAPS`).
- A new code format, or a sign-in without the code, needs a new ADR.
