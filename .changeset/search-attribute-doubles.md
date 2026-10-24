---
'@norn-ts/norn': patch
---

The client rejects `NaN` and `Infinity` for a `double` search attribute, as `setSearchAttributes()` in workflow code already did. Both now share one check.
