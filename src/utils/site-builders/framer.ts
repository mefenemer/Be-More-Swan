// src/utils/site-builders/framer.ts — Website import adapter for Framer.
// Findings, what is covered and what is not: docs/site-import-platforms/framer.md
// Tests: tests/site-platform-framer.test.ts (fixtures in tests/fixtures/site-platforms/framer/).
import type { BuilderAdapter } from './types';

export const adapter: BuilderAdapter = {
    key: 'framer',
    label: 'Framer',
    detect: (html, gen) => gen.includes('framer') || /framerusercontent\.com|data-framer-/.test(html),
};
