// src/utils/site-builders/godaddy.ts — Website import adapter for GoDaddy Website Builder.
// Findings, what is covered and what is not: docs/site-import-platforms/godaddy.md
// Tests: tests/site-platform-godaddy.test.ts (fixtures in tests/fixtures/site-platforms/godaddy/).
import type { BuilderAdapter } from './types';

export const adapter: BuilderAdapter = {
    key: 'godaddy',
    label: 'GoDaddy Website Builder',
    detect: (html, gen) => gen.includes('starfield') || /img1\.wsimg\.com|godaddy/i.test(html),
};
