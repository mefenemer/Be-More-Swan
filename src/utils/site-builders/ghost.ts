// src/utils/site-builders/ghost.ts — Website import adapter for Ghost.
// Findings, what is covered and what is not: docs/site-import-platforms/ghost.md
// Tests: tests/site-platform-ghost.test.ts (fixtures in tests/fixtures/site-platforms/ghost/).
import type { BuilderAdapter } from './types';

export const adapter: BuilderAdapter = {
    key: 'ghost',
    label: 'Ghost',
    detect: (html, gen) => gen.includes('ghost') || /ghost-(?:portal|sdk)|\/ghost\/api\//.test(html),
};
