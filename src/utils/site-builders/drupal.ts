// src/utils/site-builders/drupal.ts — Website import adapter for Drupal.
// Findings, what is covered and what is not: docs/site-import-platforms/drupal.md
// Tests: tests/site-platform-drupal.test.ts (fixtures in tests/fixtures/site-platforms/drupal/).
import type { BuilderAdapter } from './types';

export const adapter: BuilderAdapter = {
    key: 'drupal',
    label: 'Drupal',
    detect: (html, gen) => gen.includes('drupal') || /\/sites\/default\/files\/|drupal-settings-json/.test(html),
};
