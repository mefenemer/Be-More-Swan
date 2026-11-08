// src/utils/site-builders/strapi.ts — Website import adapter for Strapi.
// Findings, what is covered and what is not: docs/site-import-platforms/strapi.md
// Tests: tests/site-platform-strapi.test.ts (fixtures in tests/fixtures/site-platforms/strapi/).
import type { BuilderAdapter } from './types';

export const adapter: BuilderAdapter = {
    key: 'strapi',
    label: 'Strapi',
    detect: (html, gen) => /strapi/i.test(html),
};
