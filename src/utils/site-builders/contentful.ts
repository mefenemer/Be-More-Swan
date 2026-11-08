// src/utils/site-builders/contentful.ts — Website import adapter for Contentful.
// Findings, what is covered and what is not: docs/site-import-platforms/contentful.md
// Tests: tests/site-platform-contentful.test.ts (fixtures in tests/fixtures/site-platforms/contentful/).
import type { BuilderAdapter } from './types';

export const adapter: BuilderAdapter = {
    key: 'contentful',
    label: 'Contentful',
    detect: (html, gen) => /ctfassets\.net/.test(html),
};
