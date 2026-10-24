# @norn-ts/eslint-plugin

ESLint rules that keep [Norn](https://jamie-wk.github.io/norn/) workflow code deterministic and free of activity imports, so you see problems in your editor instead of at bundle time or on replay.

## Install

```sh
pnpm add -D @norn-ts/eslint-plugin eslint @typescript-eslint/parser
```

## Example

```js
// eslint.config.js
import tsParser from '@typescript-eslint/parser';
import norn from '@norn-ts/eslint-plugin';

export default [
  { files: ['**/*.ts'], languageOptions: { parser: tsParser } },
  norn.configs.recommended,
];
```

Full API: [reference](https://jamie-wk.github.io/norn/reference/eslint-plugin/) · [Norn docs](https://jamie-wk.github.io/norn/)

## License

MIT
