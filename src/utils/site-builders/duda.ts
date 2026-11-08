// src/utils/site-builders/duda.ts — Website import adapter for Duda.
// Findings, what is covered and what is not: docs/site-import-platforms/duda.md
// Tests: tests/site-platform-duda.test.ts (fixtures in tests/fixtures/site-platforms/duda/).
import type { BuilderAdapter } from './types';

export const adapter: BuilderAdapter = {
    key: 'duda',
    label: 'Duda',
    detect: (html, gen) => /dudamobile|multiscreensite|irp\.cdn-website\.com/i.test(html),
};
