---
'@norn-ts/norn': patch
---

`@norn-ts/norn/client` no longer exports the undocumented internals `startOptions`, `toTypedSearchAttributes`, `resolveWorkflowId` and `failureTypeOf`. Use `workflow(WorkflowClass).start()` and friends instead; the underlying Temporal client is still available as `client.temporal`.
