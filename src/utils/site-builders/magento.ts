// src/utils/site-builders/magento.ts — Website import adapter for Adobe Commerce (Magento).
// Findings, what is covered and what is not: docs/site-import-platforms/magento.md
// Tests: tests/site-platform-magento.test.ts (fixtures in tests/fixtures/site-platforms/magento/).
import type { BuilderAdapter } from './types';

export const adapter: BuilderAdapter = {
    key: 'magento',
    label: 'Adobe Commerce (Magento)',
    detect: (html, gen) => /Magento_|mage\/|requirejs-config/.test(html),
};
