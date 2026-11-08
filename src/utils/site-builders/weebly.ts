// src/utils/site-builders/weebly.ts — Website import adapter for Weebly.
// Findings, what is covered and what is not: docs/site-import-platforms/weebly.md
// Tests: tests/site-platform-weebly.test.ts (fixtures in tests/fixtures/site-platforms/weebly/).
import type { BuilderAdapter } from './types';

export const adapter: BuilderAdapter = {
    key: 'weebly',
    label: 'Weebly',
    detect: (html, gen) => gen.includes('weebly') || /editmysite\.com|weebly/i.test(html),
};
