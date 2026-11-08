// src/utils/site-builders/wix-studio.ts — Website import adapter for Wix Studio.
// Findings, what is covered and what is not: docs/site-import-platforms/wix-studio.md
// Tests: tests/site-platform-wix-studio.test.ts (fixtures in tests/fixtures/site-platforms/wix-studio/).
import type { BuilderAdapter } from './types';

export const adapter: BuilderAdapter = {
    key: 'wix-studio',
    label: 'Wix Studio',
    detect: (html, gen) => /wix-studio|wixstudio/i.test(html),
};
