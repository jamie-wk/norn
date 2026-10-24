# Notes for coding agents

This is a [Norn](https://jamie-wk.github.io/norn/) project (typed decorators on the Temporal TypeScript SDK).
Read `.claude/skills/norn/SKILL.md` before changing workflows, activities or the worker. The full docs are at
https://jamie-wk.github.io/norn/llms-full.txt.

- Workflows import activity classes with `import type` only, and call them through `useActivities<T>('namespace')`.
- Export every new workflow class from `src/workflows/index.ts`; register new activity classes in `src/worker.ts`.
- Check your work with `pnpm typecheck` and `pnpm test`.
