# An AI agent connects and reads its first report

- **Value moment:** The agent receives its first useful report (`get_email_report`).
- **Visitor:** an MCP client acting for a person who already has an account.
- **As built on `main` 6a7d775 (2026-11-15).** Consent needs an HTTPS issuer.

```mermaid
flowchart TD
  entry([Agent reads /llms.txt]) --> mcp[POST /mcp answers 401 with metadata]
  mcp --> reg[Client registration]
  reg --> signin[Person signs in in the browser]
  signin --> consent{Consent: domains, actions, expiry. Allow access?}
  consent -->|deny| denied([Agent gets no token])
  consent -->|allow| token[Token exchange]
  token --> tools[whoami and list_domains]
  tools --> report[get_email_report]:::value
```
