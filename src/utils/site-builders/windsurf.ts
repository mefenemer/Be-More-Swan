// src/utils/site-builders/windsurf.ts — Website import adapter for Windsurf.
// Findings, what is covered and what is not: docs/site-import-platforms/windsurf.md
// Tests: tests/site-platform-windsurf.test.ts (fixtures in tests/fixtures/site-platforms/windsurf/).
import type { BuilderAdapter } from './types';

export const adapter: BuilderAdapter = {
    key: 'windsurf',
    label: 'Windsurf',
    detect: (html, gen) => /windsurf|codeium/i.test(html),
};
