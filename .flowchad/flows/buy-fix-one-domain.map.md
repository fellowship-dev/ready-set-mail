# Hosted owner buys Fix one domain in the app

- **Value moment:** Fix ordered: the invoice is paid (Stripe's `invoice.paid` webhook, or the daily reconcile if the webhook is lost).
- **Visitor:** the owner of a hosted workspace with billing on.
- **As built on `main` 6a7d775 (2026-11-15).** Billing is off in production (no Stripe secrets).

```mermaid
flowchart TD
  entry([Domain page]) --> offer[Offer card: Have us fix this domain]
  offer --> confirm[Confirm: scope, refund rule, terms]
  confirm --> card{Card on file?}
  card -->|no| checkout[Add a card to continue: Stripe Checkout in setup mode]
  checkout --> confirm
  card -->|yes| pay[Pay]
  pay --> sca{3-D Secure needed?}
  sca -->|yes| invoice[Stripe hosted invoice page]
  invoice --> hook((Wait: invoice.paid webhook))
  sca -->|no| hook
  hook --> paid[Order paid]:::value
```
