// src/utils/site-builders/claude-code.ts — Website import adapter for Claude Code.
// Findings, what is covered and what is not: docs/site-import-platforms/claude-code.md
// Tests: tests/site-platform-claude-code.test.ts (fixtures in tests/fixtures/site-platforms/claude-code/).
//
// Claude Code is a coding tool, not a host: the sites people build with it (hand-written HTML with
// Tailwind's CDN, a Netlify/Decap CMS, Eleventy or Astro builds) carry no reliable trace of it, so
// `detect` stays false and the generic import reads them. What would help them is shared work
// (reading /content/*.json, Decap's config.yml, .html slugs…) — listed in the report.
import type { BuilderAdapter } from './types';

export const adapter: BuilderAdapter = {
    key: 'claude-code',
    label: 'Claude Code',
    detect: () => false,
};
