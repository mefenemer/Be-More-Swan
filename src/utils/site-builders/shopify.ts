// src/utils/site-builders/shopify.ts — Website import adapter for Shopify.
// Findings, what is covered and what is not: docs/site-import-platforms/shopify.md
// Tests: tests/site-platform-shopify.test.ts (fixtures in tests/fixtures/site-platforms/shopify/).
import type { BuilderAdapter } from './types';

export const adapter: BuilderAdapter = {
    key: 'shopify',
    label: 'Shopify',
    detect: (html, gen) => /cdn\.shopify\.com|Shopify\.theme|shopify-section/.test(html),
};
