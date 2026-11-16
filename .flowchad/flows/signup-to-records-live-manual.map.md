# New hosted user signs up and gets records live by hand

- **Value moment:** Records live: ownership proven by the TXT record and DMARC with the report address seen in public DNS.
- **Visitor:** a new hosted user whose DNS is not on Cloudflare (or who prefers to paste records).
- **As built on `main` 6a7d775 (2026-11-15).** PR #177 rebuilds sign-up; redraw and re-walk when it merges.

```mermaid
flowchart TD
  entry([Sign-up link]) --> signup[Create an account: email, password, bot check]
  signup --> mail((Wait: 6-digit code by email))
  mail --> code[Enter the 6-digit code]
  code --> first{First screen: Connect Cloudflare or add records by hand?}
  first -->|by hand| domain[Which domain do you send email from?]
  first -->|Cloudflare| cf([Cloudflare path: separate flow])
  domain --> claim[Verify you own this domain: TXT record]
  claim --> dns((Wait: DNS propagation))
  dns --> found{Record found?}
  found -->|no| claim
  found -->|yes| spf[Wizard: SPF]
  spf --> dkim[Wizard: DKIM]
  dkim --> dmarc[Wizard: DMARC with report address]
  dmarc --> dns2((Wait: DNS propagation))
  dns2 --> reports[Wizard: Reports]
  reports --> live[Records live]:::value
```
