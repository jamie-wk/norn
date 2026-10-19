---
layout: home

hero:
  name: Norn
  text: Temporal workflows that read like the story they tell
  tagline: A decorator-driven TypeScript framework on top of the Temporal SDK. Typed contracts, compile-time dependency injection, and production defaults, generated from plain classes.
  image:
    src: /logo.svg
    alt: Norn
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Why Norn?
      link: /guide/introduction
    - theme: alt
      text: GitHub
      link: https://github.com/jamie-wk/norn

features:
  - title: Workflows as classes
    details: '@Workflow, @Signal, @Query, @Update and @Validate on a plain class. The constructor gets the input before any handler runs, so state is always initialised.'
  - title: End-to-end types
    details: 'norn gen emits contracts with import type only. API code gets typed inputs, outputs, signals, queries, updates and search attributes without bundling a line of worker code.'
  - title: Workflow-safe activity references
    details: 'Activity classes are referenced from workflows through generated, type-only references, so the deterministic sandbox never imports Node code.'
  - title: Dependency injection without reflection
    details: 'TC39 standard decorators, no reflect-metadata. norn gen reads constructor types and writes the container wiring, with cycle and captive-dependency checks.'
  - title: Production defaults
    details: 'createWorker() gives you health checks, graceful SIGTERM drain, worker versioning, Prometheus metrics and correlation IDs from API request to activity log line.'
  - title: Safe to change
    details: 'norn.lock.json stops accidental renames of workflow types, handlers and activities. assertReplays() replays recorded histories in CI before you deploy.'
---
