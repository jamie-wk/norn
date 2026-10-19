// The documentation's navigation, shared by the VitePress config and scripts/llms.mjs.

/** @type {import('vitepress').DefaultTheme.SidebarItem[]} */
export const guide = [
  {
    text: 'Start here',
    items: [
      { text: 'Introduction', link: '/guide/introduction' },
      { text: 'Getting started', link: '/guide/getting-started' },
      { text: 'Project layout & codegen', link: '/guide/project-layout' },
    ],
  },
  {
    text: 'Writing workflows',
    items: [
      { text: 'Workflows', link: '/guide/workflows' },
      { text: 'Signals, queries & updates', link: '/guide/messages' },
      { text: 'Activities', link: '/guide/activities' },
      { text: 'Dependency injection', link: '/guide/dependency-injection' },
      { text: 'Child & external workflows', link: '/guide/child-workflows' },
      { text: 'Long-running workflows', link: '/guide/long-running' },
      { text: 'Errors', link: '/guide/errors' },
      { text: 'Schedules', link: '/guide/schedules' },
    ],
  },
  {
    text: 'Running in production',
    items: [
      { text: 'Client', link: '/guide/client' },
      { text: 'Worker & deployment', link: '/guide/worker' },
      { text: 'Versioning & safe deploys', link: '/guide/versioning' },
      { text: 'Testing', link: '/guide/testing' },
      { text: 'Encryption & codec server', link: '/guide/encryption' },
      { text: 'Observability', link: '/guide/observability' },
    ],
  },
  {
    text: 'Tooling & integrations',
    items: [
      { text: 'The norn CLI', link: '/guide/cli' },
      { text: 'Hono integration', link: '/guide/hono' },
      { text: 'ESLint rules', link: '/guide/eslint' },
    ],
  },
];

/** @type {import('vitepress').DefaultTheme.SidebarItem[]} */
export const recipes = [
  {
    text: 'Recipes',
    items: [
      { text: 'Overview', link: '/recipes/' },
      { text: 'Inviting a subcontractor', link: '/recipes/subcontractor-invitation' },
      { text: 'ACH payment to a subcontractor', link: '/recipes/ach-payment' },
      { text: 'Self-hosting Temporal on AWS ECS', link: '/recipes/self-hosting-aws-ecs' },
    ],
  },
];

/** @type {import('vitepress').DefaultTheme.SidebarItem[]} */
export const reference = [
  {
    text: 'API reference',
    items: [
      { text: 'Overview', link: '/reference/' },
      { text: '@norn/core', link: '/reference/core' },
      { text: '@norn/workflow', link: '/reference/workflow' },
      { text: '@norn/activity', link: '/reference/activity' },
      { text: '@norn/client', link: '/reference/client' },
      { text: '@norn/worker', link: '/reference/worker' },
      { text: '@norn/testing', link: '/reference/testing' },
      { text: '@norn/codec', link: '/reference/codec' },
      { text: '@norn/hono', link: '/reference/hono' },
      { text: '@norn/cli', link: '/reference/cli' },
      { text: '@norn/eslint-plugin', link: '/reference/eslint-plugin' },
    ],
  },
];

/** @type {import('vitepress').DefaultTheme.SidebarItem[]} */
export const comparisons = [
  {
    text: 'Comparisons',
    items: [
      { text: 'vs the plain Temporal SDK', link: '/comparisons/plain-sdk' },
      { text: 'vs nestjs-temporal style libraries', link: '/comparisons/nestjs-temporal' },
      { text: 'vs Java, Python and .NET SDKs', link: '/comparisons/other-sdks' },
    ],
  },
];

/** @type {import('vitepress').DefaultTheme.SidebarItem[]} */
export const project = [
  {
    text: 'Project',
    items: [
      { text: 'Changelog & upgrading', link: '/changelog' },
      { text: 'Contributing', link: '/contributing' },
    ],
  },
];

/** @type {import('vitepress').DefaultTheme.Sidebar} */
export const sidebar = {
  '/guide/': [...guide, ...project],
  '/recipes/': recipes,
  '/reference/': reference,
  '/comparisons/': comparisons,
  '/changelog': [...guide, ...project],
  '/contributing': [...guide, ...project],
};
