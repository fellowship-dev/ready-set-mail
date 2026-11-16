# New hosted user signs up and gets records live through Cloudflare

- **Value moment:** Records live: ownership proven and DMARC with the report address seen in public DNS.
- **Visitor:** a new hosted user who arrives at the sign-up link with a domain on Cloudflare.
- **As built on `main` 6a7d775 (2026-11-15).** PR #177 rebuilds sign-up; redraw and re-walk when it merges.

```mermaid
flowchart TD
  entry([Sign-up link]) --> signup[Create an account: email, password, bot check]
  signup --> mail((Wait: 6-digit code by email))
  mail --> code[Enter the 6-digit code]
  code --> first{First screen: Connect Cloudflare or add records by hand?}
  first -->|Cloudflare| cont[Continue to Cloudflare]
  first -->|by hand| manual([Manual path: separate flow])
  cont --> consent{Cloudflare consent: allow?}
  consent -->|deny| first
  consent -->|allow| imported[Overview: all active zones imported, verified by the connection]
  imported --> pick{Which domain to fix?}
  pick --> domain[Domain page: plan, DMARC with report address]
  domain --> apply{Apply this change?}
  apply -->|not now| imported
  apply -->|Apply| live[Records live]:::value
```
