// src/utils/site-builders/squarespace.ts — Website import adapter for Squarespace.
// Findings, what is covered and what is not: docs/site-import-platforms/squarespace.md
// Tests: tests/site-platform-squarespace.test.ts (fixtures in tests/fixtures/site-platforms/squarespace/).
import type { BuilderAdapter } from './types';

export const adapter: BuilderAdapter = {
    key: 'squarespace',
    label: 'Squarespace',
    detect: (html, gen) => gen.includes('squarespace') || /squarespace-cdn\.com|static1\.squarespace\.com/.test(html),
};
