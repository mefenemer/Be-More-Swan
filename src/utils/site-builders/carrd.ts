// src/utils/site-builders/carrd.ts — Website import adapter for Carrd.
// Findings, what is covered and what is not: docs/site-import-platforms/carrd.md
// Tests: tests/site-platform-carrd.test.ts (fixtures in tests/fixtures/site-platforms/carrd/).
import type { BuilderAdapter } from './types';

export const adapter: BuilderAdapter = {
    key: 'carrd',
    label: 'Carrd',
    detect: (html, gen) => gen.includes('carrd') || /carrd\.co/.test(html),
};
