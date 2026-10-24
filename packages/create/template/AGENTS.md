# Notes for coding agents

This is a [Norn](https://jamie-wk.github.io/norn/) project (typed decorators on the Temporal TypeScript SDK).
Read `.claude/skills/norn/SKILL.md` before changing workflows, activities or the worker. The full docs are at
https://jamie-wk.github.io/norn/llms-full.txt.

- Run `pnpm gen` after changing any decorated class, and commit `.norn/` and `norn.lock.json`.
- Workflows import activities from `.norn/activities`, never from `src/activities`.
- Check your work with `pnpm typecheck` and `pnpm test`.
