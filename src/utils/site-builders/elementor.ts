// src/utils/site-builders/elementor.ts — Website import adapter for Elementor.
// Findings, what is covered and what is not: docs/site-import-platforms/elementor.md
// Tests: tests/site-platform-elementor.test.ts (fixtures in tests/fixtures/site-platforms/elementor/).
import type { BuilderAdapter } from './types';

export const adapter: BuilderAdapter = {
    key: 'elementor',
    label: 'Elementor',
    detect: (html, gen) => /elementor-(?:kit|section|element|widget)|\/elementor\//.test(html),
};
