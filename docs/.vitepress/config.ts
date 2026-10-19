import { defineConfig } from 'vitepress';
import { sidebar } from './sidebar.mjs';

const repo = 'https://github.com/jamie-wk/norn';

export default defineConfig({
  lang: 'en-US',
  title: 'Norn',
  description: 'Typed, decorator-driven Temporal workflows for TypeScript.',
  base: '/norn/',
  cleanUrls: true,
  lastUpdated: false,
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/norn/logo.svg' }],
    ['meta', { name: 'theme-color', content: '#5b4cc4' }],
    ['meta', { property: 'og:title', content: 'Norn' }],
    ['meta', { property: 'og:description', content: 'Typed, decorator-driven Temporal workflows for TypeScript.' }],
  ],
  markdown: {
    lineNumbers: false,
  },
  themeConfig: {
    logo: '/logo.svg',
    siteTitle: 'Norn',
    nav: [
      { text: 'Guide', link: '/guide/introduction', activeMatch: '^/guide/' },
      { text: 'Recipes', link: '/recipes/', activeMatch: '^/recipes/' },
      { text: 'Reference', link: '/reference/', activeMatch: '^/reference/' },
      { text: 'Comparisons', link: '/comparisons/plain-sdk', activeMatch: '^/comparisons/' },
      {
        text: '1.0',
        items: [
          { text: 'Changelog & upgrading', link: '/changelog' },
          { text: 'Contributing', link: '/contributing' },
          { text: 'Releases', link: `${repo}/releases` },
          { text: 'npm', link: 'https://www.npmjs.com/org/norn' },
        ],
      },
    ],
    sidebar,
    search: { provider: 'local' },
    editLink: {
      pattern: `${repo}/edit/main/docs/:path`,
      text: 'Edit this page on GitHub',
    },
    socialLinks: [{ icon: 'github', link: repo }],
    outline: { level: [2, 3] },
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026 Jamie King',
    },
  },
});
