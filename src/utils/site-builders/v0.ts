// src/utils/site-builders/v0.ts — Website import adapter for v0.
// Findings, what is covered and what is not: docs/site-import-platforms/v0.md
// Tests: tests/site-platform-v0.test.ts (fixtures in tests/fixtures/site-platforms/v0/).
import type { BuilderAdapter } from './types';

export const adapter: BuilderAdapter = {
    key: 'v0',
    label: 'v0',
    detect: (html, gen) => /v0\.dev|v0\.app/i.test(html),
};
