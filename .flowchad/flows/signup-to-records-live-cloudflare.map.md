# New hosted user signs up and gets records live through Cloudflare

- **Value moment:** Records live: ownership proven and DMARC seen in public DNS. The report address is in the record only for a workspace `HOSTED_CONNECT_REPORTS` admits (by default the operator's own); any other new customer gets DMARC without it.
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
  pick --> domain[Domain page: plan, DMARC record]
  domain --> apply{Apply this change?}
  apply -->|not now| imported
  apply -->|Apply| live[Records live]:::value
```
