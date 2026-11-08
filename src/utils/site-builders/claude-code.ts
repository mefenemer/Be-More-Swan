// src/utils/site-builders/claude-code.ts — Website import adapter for Claude Code.
// Findings, what is covered and what is not: docs/site-import-platforms/claude-code.md
// Tests: tests/site-platform-claude-code.test.ts (fixtures in tests/fixtures/site-platforms/claude-code/).
import type { BuilderAdapter } from './types';

export const adapter: BuilderAdapter = {
    key: 'claude-code',
    label: 'Claude Code',
    detect: (html, gen) => false,
};
