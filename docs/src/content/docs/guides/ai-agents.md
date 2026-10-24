---
title: Using Norn with AI agents
description: The agent skill, AGENTS.md and llms.txt files that teach coding agents how to write Norn code.
---

Coding agents are good at Temporal's general ideas, but they don't know Norn's conventions, such as where workflows import activities from or when to run `norn gen`. Norn ships three things to close that gap.

## The agent skill

`skills/norn/SKILL.md` in the [Norn repository](https://github.com/jamie-wk/norn/blob/main/skills/norn/SKILL.md) is an [agent skill](https://docs.claude.com/en/docs/agents-and-tools/agent-skills/overview): a short guide to the mental model (the three places code runs), the generated `.norn/` files, recipes for each kind of change, and the mistakes agents make most often. Agents that support skills load it when they work on Norn code.

Projects created with `pnpm create @norn-ts` already include it at `.claude/skills/norn/SKILL.md`. To add it to an existing project, run this in the project root:

```sh
mkdir -p .claude/skills/norn
curl -fsSL https://raw.githubusercontent.com/jamie-wk/norn/main/skills/norn/SKILL.md -o .claude/skills/norn/SKILL.md
```

Commit it, so everyone working on the project, human or agent, gets the same guidance. Pin it to a release tag instead of `main` if you want it to match your Norn version exactly.

## AGENTS.md

The starter also has an `AGENTS.md`, which many coding agents read automatically. It points to the skill and the docs, and lists the three rules that matter most:

- Run `pnpm gen` after changing any decorated class, and commit `.norn/` and `norn.lock.json`.
- Workflows import activities from `.norn/activities`, never from `src/activities`.
- Check your work with `pnpm typecheck` and `pnpm test`.

Add your project's own conventions to it as they come up.

## The docs as plain text

These docs are also published as plain text for language models, following the [llms.txt](https://llmstxt.org) convention:

| File | What it has |
| --- | --- |
| [`/norn/llms.txt`](https://jamie-wk.github.io/norn/llms.txt) | An index of the docs with links |
| [`/norn/llms-full.txt`](https://jamie-wk.github.io/norn/llms-full.txt) | Every page in one file |
| [`/norn/llms-small.txt`](https://jamie-wk.github.io/norn/llms-small.txt) | Every page, condensed for smaller context windows |

Give an agent `llms-full.txt` when it needs the full API, for example to write a reference-heavy change.

## Getting good results

- **Let the compiler check the agent's work.** Norn moves most mistakes to compile time: wrong signal names, ID templates that don't match the input, activities imported into workflows. Ask the agent to run `pnpm typecheck` and `pnpm test` after each change, and to fix what they report.
- **Ask for tests with the change.** `useTestEnv()` with `mockActivities()` makes workflow tests short. An agent that writes the test first catches determinism and timing mistakes before you do.
- **Review workflow changes for compatibility.** Changing a running workflow's logic can break replay of in-flight executions. Agents rarely think about this unprompted. Point them at [Versioning & safe deploys](/norn/guides/versioning/) and ask for a replay test.
