// src/utils/site-builders/replit.ts — Website import adapter for Replit.
// Findings, what is covered and what is not: docs/site-import-platforms/replit.md
// Tests: tests/site-platform-replit.test.ts (fixtures in tests/fixtures/site-platforms/replit/).
import type { BuilderAdapter } from './types';

export const adapter: BuilderAdapter = {
    key: 'replit',
    label: 'Replit',
    detect: (html, gen) => /replit\.(app|dev|com)/i.test(html),
};
