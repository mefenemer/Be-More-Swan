// src/utils/site-builders/wix.ts — Website import adapter for Wix.
// Findings, what is covered and what is not: docs/site-import-platforms/wix.md
// Tests: tests/site-platform-wix.test.ts (fixtures in tests/fixtures/site-platforms/wix/).
import type { BuilderAdapter } from './types';

export const adapter: BuilderAdapter = {
    key: 'wix',
    label: 'Wix',
    detect: (html, gen) => gen.includes('wix') || /static\.wixstatic\.com|wix-thunderbolt/.test(html),
};
