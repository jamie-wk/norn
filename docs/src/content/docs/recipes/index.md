---
title: "Recipes"
---

End-to-end examples of real workflows, built with Norn. They come from a construction-payments product, where a general contractor (GC) invites subcontractors to a project, agrees terms with them and pays them by ACH, but the patterns are general: invitations with expiry and human-in-the-loop approvals.

| Recipe | Shows |
| --- | --- |
| [Inviting a subcontractor](/norn/recipes/subcontractor-invitation/) | Expiry timers, reminder emails, accept/decline signals, an update with a validator for changing terms, search attributes, time-skipping tests. |

:::note[Illustrative code]
The recipes are written against Norn's real APIs and are meant to compile with small adjustments, but they are illustrative: provider APIs (payments, email), table schemas and infrastructure sizes are placeholders to adapt to your system. Check your payment provider's and NACHA's rules before moving real money.
:::
