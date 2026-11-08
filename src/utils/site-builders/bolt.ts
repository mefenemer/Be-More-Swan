// src/utils/site-builders/bolt.ts — Website import adapter for Bolt.new.
// Findings, what is covered and what is not: docs/site-import-platforms/bolt.md
// Tests: tests/site-platform-bolt.test.ts (fixtures in tests/fixtures/site-platforms/bolt/).
import type { BuilderAdapter } from './types';

export const adapter: BuilderAdapter = {
    key: 'bolt',
    label: 'Bolt.new',
    detect: (html, gen) => /bolt\.new|stackblitz/i.test(html),
};
