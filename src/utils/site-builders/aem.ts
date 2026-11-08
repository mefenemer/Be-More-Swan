// src/utils/site-builders/aem.ts — Website import adapter for Adobe Experience Manager.
// Findings, what is covered and what is not: docs/site-import-platforms/aem.md
// Tests: tests/site-platform-aem.test.ts (fixtures in tests/fixtures/site-platforms/aem/).
import type { BuilderAdapter } from './types';

export const adapter: BuilderAdapter = {
    key: 'aem',
    label: 'Adobe Experience Manager',
    detect: (html, gen) => /\/etc\.clientlibs\/|\/content\/dam\//.test(html),
};
