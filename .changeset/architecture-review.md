---
'@norn-ts/core': minor
'@norn-ts/client': minor
'@norn-ts/worker': minor
'@norn-ts/testing': minor
'@norn-ts/cli': minor
'@norn-ts/hono': minor
'@norn-ts/workflow': patch
---

Shared rules instead of per-package copies, and the drift they caused fixed:

- **Fixed:** `mockActivities()` registers renamed activities (`@Activity({ name })`) under their registered name. It used the method name, so the worker rejected the mock.
- **Fixed:** `createFakeClient()` behaves like the real client:
  - It validates start options (`ifRunning`, `ifClosed`, search attributes, durations).
  - An update stub that throws becomes `UpdateRejectedError`, and a query stub that throws becomes `QueryFailedError`.
  - A shared conformance suite runs the same scenarios against both clients.
- **Fixed:** the client rejects `NaN` and `Infinity` for `double` search attributes, as workflows already did.
- **New:** one `connectionSettings()` in `@norn-ts/core` resolves `TEMPORAL_*` variables for the client, worker and CLI.
  - Empty values now count as unset everywhere.
  - `createClient()` and `createWorker()` read `TEMPORAL_TLS_CERT` / `TEMPORAL_TLS_KEY` for mTLS, which only the CLI did before.
- **Fixed:** `norn gen` applies the runtime's decorator rules. It now reports invalid ID templates, zero timeouts, `retry.backoffCoefficient` below 1, and async `@Query` / `@Validate` methods, instead of letting them fail at import.
- **Improved:** activity duration errors name the field.
- **New core exports:** `activityName()`, `connectionSettings()`, `isSearchAttributeValue()`, `NORN_ERROR_STATUS`, `SCHEDULE_OVERLAPS`.
- **Hono:**
  - `NornErrorCode` is derived from core's codes and now lists the codec-server codes.
  - Codec-server error responses use the standard body with a `correlationId`.
