// src/utils/site-builders/joomla.ts — Website import adapter for Joomla.
// Findings, what is covered and what is not: docs/site-import-platforms/joomla.md
// Tests: tests/site-platform-joomla.test.ts (fixtures in tests/fixtures/site-platforms/joomla/).
import type { BuilderAdapter } from './types';

export const adapter: BuilderAdapter = {
    key: 'joomla',
    label: 'Joomla',
    detect: (html, gen) => gen.includes('joomla') || /\/media\/jui\/|\/components\/com_/.test(html),
};
