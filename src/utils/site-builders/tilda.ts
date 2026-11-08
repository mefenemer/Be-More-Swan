// src/utils/site-builders/tilda.ts — Website import adapter for Tilda.
// Findings, what is covered and what is not: docs/site-import-platforms/tilda.md
// Tests: tests/site-platform-tilda.test.ts (fixtures in tests/fixtures/site-platforms/tilda/).
import type { BuilderAdapter } from './types';

export const adapter: BuilderAdapter = {
    key: 'tilda',
    label: 'Tilda',
    detect: (html, gen) => gen.includes('tilda') || /tildacdn\.com|t-records/.test(html),
};
