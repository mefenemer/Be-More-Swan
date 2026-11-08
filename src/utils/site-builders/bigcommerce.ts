// src/utils/site-builders/bigcommerce.ts — Website import adapter for BigCommerce.
// Findings, what is covered and what is not: docs/site-import-platforms/bigcommerce.md
// Tests: tests/site-platform-bigcommerce.test.ts (fixtures in tests/fixtures/site-platforms/bigcommerce/).
import type { BuilderAdapter } from './types';

export const adapter: BuilderAdapter = {
    key: 'bigcommerce',
    label: 'BigCommerce',
    detect: (html, gen) => /cdn\d*\.bigcommerce\.com|bigcommerce/i.test(html),
};
