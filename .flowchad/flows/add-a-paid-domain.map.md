# Hosted owner adds a second domain on Pay as you go

- **Value moment:** Domain added and billed: the subscription's quantity is raised (server-side, under the workspace's lease) and the list says it.
- **Visitor:** the owner of a hosted workspace with `HOSTED_PLAN=free_one_domain`, billing on, one free domain already added.
- **As built in this pull request.** Off in production until the operator switches the setting on. Walked in `e2e/ux-walk.spec.ts` (375 and 1440, light): measures in the PR's UX gate table.

```mermaid
flowchart TD
  entry([Add domain]) --> typed[Type the domain]
  typed --> room{Room in the free plan?}
  room -->|yes: first domain or a subdomain| added[Domain added, no price anywhere]:::value
  room -->|no: 402 plan_required| owner{Owner?}
  owner -->|no| ask[Ask the workspace owner to add more domains]
  owner -->|yes| confirm[Confirm: monthly price, next invoice amount and date, card, one button]
  confirm --> card{Card on file?}
  card -->|no| checkout[Add a card to continue: Stripe Checkout in setup mode]
  checkout --> confirm
  card -->|yes| click[One button: Pay $5 and add when charged now, Add for $5 a month when prorated]
  click -->|bank must confirm| bank[Waiting for the bank: Try again or Cancel]
  bank --> billed
  click --> proof{Domain proven?}
  proof -->|no| txt[Publish the TXT record, then confirm again]
  txt --> click
  proof -->|yes| billed[Quantity raised, list says Added]:::value
```
