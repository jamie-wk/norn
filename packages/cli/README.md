# @norn-ts/cli

The `norn` command for [Norn](https://jamie-wk.github.io/norn/) projects. It generates `.norn/` (workflow entry, activity references, contracts, DI container, worker registry) from your decorated classes without running them, checks workflow code against the sandbox, syncs `@Schedule`s, pulls histories for replay tests and bundles workflows for production.

## Install

```sh
pnpm add -D @norn-ts/cli
```

```sh
# generate .norn/ and norn.lock.json
pnpm norn gen
# in CI: fail if generated files are stale
pnpm norn gen --check
```

Full reference: [reference](https://jamie-wk.github.io/norn/reference/cli/) · [Norn docs](https://jamie-wk.github.io/norn/)

## License

MIT
