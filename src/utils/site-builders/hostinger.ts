// src/utils/site-builders/hostinger.ts — Website import adapter for Hostinger Website Builder.
// Findings, what is covered and what is not: docs/site-import-platforms/hostinger.md
// Tests: tests/site-platform-hostinger.test.ts (fixtures in tests/fixtures/site-platforms/hostinger/).
import type { BuilderAdapter } from './types';

export const adapter: BuilderAdapter = {
    key: 'hostinger',
    label: 'Hostinger Website Builder',
    detect: (html, gen) => gen.includes('hostinger') || /zyrosite\.com|zyro/i.test(html),
};
