# Hosted owner creates a second workspace

- **Value moment:** the new workspace exists and the person is in it.
- **Visitor:** the owner of a hosted workspace with `HOSTED_PLAN=free_one_domain` who already holds their free domain.
- **As built in this pull request (server side; the screens are the next phase).**

```mermaid
flowchart TD
  entry([New workspace]) --> name[Name it]
  name --> eligible{Holds no free domain, or already pays?}
  eligible -->|yes| created[Workspace created]:::value
  eligible -->|no: 402 workspace_needs_card| explain[Add a card to create more workspaces]
  explain --> checkout[Add a card to continue: Stripe Checkout in setup mode]
  checkout --> back[Back: the workspace is created once the card is verified]
  back --> created
```
