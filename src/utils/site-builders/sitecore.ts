// src/utils/site-builders/sitecore.ts — Website import adapter for Sitecore.
// Findings, what is covered and what is not: docs/site-import-platforms/sitecore.md
// Tests: tests/site-platform-sitecore.test.ts (fixtures in tests/fixtures/site-platforms/sitecore/).
import type { BuilderAdapter } from './types';

export const adapter: BuilderAdapter = {
    key: 'sitecore',
    label: 'Sitecore',
    detect: (html, gen) => /sitecore|\/-\/media\//i.test(html),
};
