# New hosted user signs up and gets DMARC live by adding records by hand

- **Value moment:** Records live: ownership proven by the TXT record and DMARC seen in public DNS. The report address is in the record only for a workspace `HOSTED_CONNECT_REPORTS` admits (by default the operator's own); any other new customer gets DMARC without it.
- **Visitor:** a new hosted user whose DNS is not on Cloudflare (or who prefers to paste records).
- **As built by PR #177 (2026-11-16).** S1 to S4, then the record screen, which looks for the record every 15 seconds while open, and the first-day card, which looks for the DMARC record the same way.

```mermaid
flowchart TD
  entry([Sign-up link]) --> s1[S1 Create your account: email and password]
  s1 --> s2[S2 Tell us about yourself]
  s2 --> s3[S3 Check your inbox: the 6-digit code]
  s3 --> s4[S4 Which domain? One line of public DNS and the choice]
  s4 -->|Cloudflare| cf([Cloudflare path: separate flow])
  s4 -->|records| claim[Add the TXT record at the DNS host]
  claim --> dns((Wait: record in public DNS, looked for every 15 s))
  dns --> found{Record found?}
  found -->|no| claim
  found -->|yes| d1[First-day dashboard: waiting for the report address in DMARC]
  d1 --> dmarc[Domain page: the DMARC record to add]
  dmarc --> dns2((Wait: record in public DNS, looked for every 15 s))
  dns2 --> live[Records live: first reports on their way]:::value
```
