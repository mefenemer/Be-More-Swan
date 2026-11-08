// src/utils/site-builders/webflow.ts — Website import adapter for Webflow.
// Findings, what is covered and what is not: docs/site-import-platforms/webflow.md
// Tests: tests/site-platform-webflow.test.ts (fixtures in tests/fixtures/site-platforms/webflow/).
import type { BuilderAdapter } from './types';

export const adapter: BuilderAdapter = {
    key: 'webflow',
    label: 'Webflow',
    detect: (html, gen) => gen.includes('webflow') || /webflow\.(js|css)|data-wf-page/.test(html),
};
