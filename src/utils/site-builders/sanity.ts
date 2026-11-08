// src/utils/site-builders/sanity.ts — Website import adapter for Sanity.
// Findings, what is covered and what is not: docs/site-import-platforms/sanity.md
// Tests: tests/site-platform-sanity.test.ts (fixtures in tests/fixtures/site-platforms/sanity/).
import type { BuilderAdapter } from './types';

export const adapter: BuilderAdapter = {
    key: 'sanity',
    label: 'Sanity',
    detect: (html, gen) => /cdn\.sanity\.io/.test(html),
};
