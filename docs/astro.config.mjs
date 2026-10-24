import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import starlightLinksValidator from 'starlight-links-validator';
import starlightLlmsTxt from 'starlight-llms-txt';

const repo = 'https://github.com/jamie-wk/norn';

export default defineConfig({
  site: 'https://jamie-wk.github.io',
  base: '/norn',
  trailingSlash: 'always',
  integrations: [
    starlight({
      title: 'Norn',
      description: 'Typed, decorator-driven Temporal workflows for TypeScript.',
      logo: { src: './src/assets/logo.svg' },
      favicon: '/favicon.svg',
      customCss: ['./src/styles/theme.css'],
      social: [{ icon: 'github', label: 'GitHub', href: repo }],
      editLink: { baseUrl: `${repo}/edit/main/docs/` },
      lastUpdated: false,
      plugins: [
        // Fails the build on a broken internal link or anchor.
        starlightLinksValidator(),
        starlightLlmsTxt({
          projectName: 'Norn',
          description:
            'Typed, decorator-driven Temporal workflows for TypeScript: TC39 decorators, generated contracts and compile-time type safety on top of the Temporal TypeScript SDK.',
        }),
      ],
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'Introduction', slug: 'start/introduction' },
            { label: 'Quickstart', slug: 'start/quickstart' },
            { label: 'Coming from the Temporal SDK', slug: 'start/coming-from-temporal' },
          ],
        },
        { label: 'Tutorial', items: [{ autogenerate: { directory: 'tutorial' } }] },
        {
          label: 'Concepts',
          items: [
            { label: 'Durable execution in 5 minutes', slug: 'concepts/durable-execution' },
            { label: 'Determinism & the sandbox', slug: 'concepts/determinism' },
            { label: 'Codegen & .norn/', slug: 'concepts/codegen' },
            { label: 'Contracts & the client/worker split', slug: 'concepts/contracts' },
          ],
        },
        {
          label: 'Guides',
          items: [
            {
              label: 'Writing workflows',
              items: [
                'guides/workflows',
                'guides/messages',
                'guides/activities',
                'guides/dependency-injection',
                'guides/child-workflows',
                'guides/long-running',
                'guides/errors',
                'guides/schedules',
              ],
            },
            {
              label: 'Running in production',
              items: ['guides/client', 'guides/worker', 'guides/versioning', 'guides/testing', 'guides/encryption', 'guides/observability'],
            },
            {
              label: 'Project setup',
              items: ['guides/manual-setup', 'guides/project-layout', 'guides/hono', 'guides/eslint', 'guides/ai-agents'],
            },
          ],
        },
        { label: 'Reference', items: [{ autogenerate: { directory: 'reference' } }] },
        { label: 'Recipes', items: [{ autogenerate: { directory: 'recipes' } }] },
        { label: 'Project', items: ['project/changelog', 'project/contributing'] },
      ],
    }),
  ],
});
