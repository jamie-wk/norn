# @norn-ts/create

Creates a new [Norn](https://jamie-wk.github.io/norn/) project.

```sh
pnpm create @norn-ts my-app
# or: npm create @norn-ts@latest my-app
cd my-app
pnpm dev
```

The project has an order workflow with a signal and a query, an activity class with an injected service, a worker, a client script and tests on Temporal's time-skipping server. `pnpm dev` starts a local Temporal server (unless one is already running on `localhost:7233`), `norn gen --watch` and the worker, and restarts the worker when you change a file. The only prerequisite is Node 22.18+.

| Option | What it does |
| --- | --- |
| `<project-name>` | The directory to create. The package is named after its last segment; `.` uses the current directory. |
| `--force` | Write into a directory that is not empty. Files with the same names as the template's are replaced. |
| `--no-install` | Skip installing dependencies and running `norn gen`. |

The package manager that ran the command (pnpm, npm, yarn or bun) installs the dependencies. The project also includes `AGENTS.md` and the Norn agent skill in `.claude/skills/norn/`, so coding agents know the framework.

Walk through it in the [quickstart](https://jamie-wk.github.io/norn/start/quickstart/).
