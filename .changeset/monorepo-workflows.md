---
'@norn-ts/norn': patch
---

`createWorker({ workflows })`, `createTestEnv({ workflows })` and `bundleWorkflows()` accept a `file://` URL string, such as `import.meta.resolve('@acme/workflows')` returns. Before, it was read as a relative path and failed. The docs' Recipes page now covers monorepos.
