import starlight from '@astrojs/starlight';
import { defineConfig, passthroughImageService } from 'astro/config';
import starlightLinksValidator from 'starlight-links-validator';
import starlightLlmsTxt from 'starlight-llms-txt';

const repo = 'https://github.com/jamie-wk/norn';

export default defineConfig({
  site: 'https://jamie-wk.github.io',
  base: '/norn',
  trailingSlash: 'always',
  // The only images are SVGs, so there is nothing for sharp to optimize.
  image: { service: passthroughImageService() },
  integrations: [
    starlight({
      title: 'Norn',
      description: 'Write Temporal workflows and activities as plain, typed TypeScript classes.',
      logo: { src: './src/assets/logo.svg' },
      favicon: '/favicon.svg',
      customCss: ['./src/styles/theme.css'],
      components: { Search: './src/components/Search.astro' },
      social: [{ icon: 'github', label: 'GitHub', href: repo }],
      editLink: { baseUrl: `${repo}/edit/main/docs/` },
      lastUpdated: false,
      plugins: [
        // Fails the build on a broken internal link or anchor.
        starlightLinksValidator(),
        starlightLlmsTxt({
          projectName: 'Norn',
          description:
            'Norn: write Temporal workflows and activities as plain, typed TypeScript classes. Decorated workflow classes, plain activity classes and a client typed from the workflow, on top of the Temporal TypeScript SDK. One package, @norn-ts/norn, no codegen.',
        }),
      ],
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'Quickstart', slug: 'start/quickstart' },
            { label: 'Coming from the Temporal SDK', slug: 'start/coming-from-temporal' },
          ],
        },
        {
          label: 'Concepts',
          items: [
            { label: 'Durable execution in 5 minutes', slug: 'concepts/durable-execution' },
            { label: 'Determinism & the sandbox', slug: 'concepts/determinism' },
          ],
        },
        { label: 'Guides', items: ['guides/workflows', 'guides/activities', 'guides/worker', 'guides/client', 'guides/testing'] },
        { label: 'Reference', items: ['reference', 'recipes'] },
        { label: 'Project', items: ['project/changelog', 'project/contributing'] },
      ],
    }),
  ],
});
