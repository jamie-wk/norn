# Recipes

End-to-end examples of real workflows, built with Norn. They come from a construction-payments product, where a general contractor (GC) invites subcontractors to a project, agrees terms with them and pays them by ACH, but the patterns are general: invitations with expiry, human-in-the-loop approvals, payments with webhooks and compensation, and running Temporal yourself.

| Recipe | Shows |
| --- | --- |
| [Inviting a subcontractor](/recipes/subcontractor-invitation) | Expiry timers, reminder emails, accept/decline signals, an update with a validator for changing terms, search attributes, time-skipping tests. |
| [ACH payment to a subcontractor](/recipes/ach-payment) | An idempotent transfer through an injected `TransferService`, settlement by webhook signal with a polling fallback, cancellation before submission, return handling (R01, R03, ...) with compensation, business-day timers. |
| [Self-hosting Temporal on AWS ECS](/recipes/self-hosting-aws-ecs) | Temporal server, UI and Norn workers on ECS Fargate with CDK; one Postgres instance with separate history and visibility databases; schema migrations; local development with Docker Compose. |

::: info Illustrative code
The recipes are written against Norn's real APIs and are meant to compile with small adjustments, but they are illustrative: provider APIs (payments, email), table schemas and infrastructure sizes are placeholders to adapt to your system. Check your payment provider's and NACHA's rules before moving real money.
:::
