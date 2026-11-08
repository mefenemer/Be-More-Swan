// src/utils/site-builders/lovable.ts — Website import adapter for Lovable.
// Findings, what is covered and what is not: docs/site-import-platforms/lovable.md
// Tests: tests/site-platform-lovable.test.ts (fixtures in tests/fixtures/site-platforms/lovable/).
import type { BuilderAdapter } from './types';

export const adapter: BuilderAdapter = {
    key: 'lovable',
    label: 'Lovable',
    detect: (html, gen) => /lovable\.(app|dev)|gpt-engineer/i.test(html),
};
