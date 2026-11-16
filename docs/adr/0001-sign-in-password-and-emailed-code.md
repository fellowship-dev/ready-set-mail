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
- **Amendment, 2026-11-16 (PR 177 recheck): the sign-up code mail allowance is 5 an hour and 10 a day per address** (`CODE_MAIL_CAPS.signup`; it was 2 and 4). Wrong-code limits, 5 tries per code and the 10-minute lifetime are unchanged. Why: one honest sign-up can legitimately mail the same address four times in a few minutes (the code expires on the about-you screen, the password is typed again, "Send a new code", "Start over" with the same address), and at 2 an hour the third mail told a real person to wait an hour. The daily 10 cannot bite before the hourly 5 does for a person who is not retrying all day. The wait message states the real time left in the limiter's window (minutes rounded up, "1 minute" singular), not a fixed hour.
- **Rate-limit analysis (what the per-address allowance can and cannot tell).** The allowance counts mails to an ADDRESS. It cannot tell an attacker's sign-up for `victim@example.com` from the owner's own, because nothing is proven about the address until a code is entered (and answering differently for an address with an account would reveal accounts). So an attacker can spend the owner's allowance. The mitigation is arithmetic, not identification: 5 an hour means two attacker sign-ups leave the owner three; reaching the cap takes five requests an hour per address, and each needs a Turnstile pass and fits the per-IP limit (10 sign-ups an hour per IP, 10 requests a minute per IP). Blocking one address for good therefore costs an attacker a bot-checked request every few minutes from several IPs, and an owner who already has an account is never locked out of signing in (`signin` and `reset` are pools a stranger cannot spend). Raising the cap further would help an attacker's mailing of strangers, so it stays small.
