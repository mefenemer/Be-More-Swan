// src/utils/site-builders/woocommerce.ts — Website import adapter for WooCommerce.
// Findings, what is covered and what is not: docs/site-import-platforms/woocommerce.md
// Tests: tests/site-platform-woocommerce.test.ts (fixtures in tests/fixtures/site-platforms/woocommerce/).
import type { BuilderAdapter } from './types';

export const adapter: BuilderAdapter = {
    key: 'woocommerce',
    label: 'WooCommerce',
    detect: (html, gen) => /woocommerce/.test(html),
};
