// src/utils/site-builders/cursor.ts — Website import adapter for Cursor.
// Findings, what is covered and what is not: docs/site-import-platforms/cursor.md
// Tests: tests/site-platform-cursor.test.ts (fixtures in tests/fixtures/site-platforms/cursor/).
import type { BuilderAdapter } from './types';

export const adapter: BuilderAdapter = {
    key: 'cursor',
    label: 'Cursor',
    detect: (html, gen) => false,
};
