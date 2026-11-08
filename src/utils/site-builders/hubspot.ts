// src/utils/site-builders/hubspot.ts — Website import adapter for HubSpot Content Hub.
// Findings, what is covered and what is not: docs/site-import-platforms/hubspot.md
// Tests: tests/site-platform-hubspot.test.ts (fixtures in tests/fixtures/site-platforms/hubspot/).
import type { BuilderAdapter } from './types';

export const adapter: BuilderAdapter = {
    key: 'hubspot',
    label: 'HubSpot Content Hub',
    detect: (html, gen) => gen.includes('hubspot') || /hs-scripts\.com|hubspotusercontent|hs-sites/.test(html),
};
