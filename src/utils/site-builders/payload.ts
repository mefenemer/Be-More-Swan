// src/utils/site-builders/payload.ts — Website import adapter for Payload CMS.
// Findings, what is covered and what is not: docs/site-import-platforms/payload.md
// Tests: tests/site-platform-payload.test.ts (fixtures in tests/fixtures/site-platforms/payload/).
import type { BuilderAdapter } from './types';

export const adapter: BuilderAdapter = {
    key: 'payload',
    label: 'Payload CMS',
    detect: (html, gen) => /payloadcms|\/api\/media\/file\//i.test(html),
};
