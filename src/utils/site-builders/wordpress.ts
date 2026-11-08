// src/utils/site-builders/wordpress.ts — Website import adapter for WordPress.
// Findings, what is covered and what is not: docs/site-import-platforms/wordpress.md
// Tests: tests/site-platform-wordpress.test.ts (fixtures in tests/fixtures/site-platforms/wordpress/).
import type { BuilderAdapter } from './types';

export const adapter: BuilderAdapter = {
    key: 'wordpress',
    label: 'WordPress',
    detect: (html, gen) => gen.includes('wordpress') || /\/wp-content\/|\/wp-includes\//.test(html),
};
