// tests/connection-policy.test.ts
// Server-side connection sandboxing (src/utils/connection-map.ts).
//
// Run:  npx tsx tests/connection-policy.test.ts
//
// Verifies the security-critical behaviour enforced in integrations.ts:
//   - an assistant may only use connectors relevant to its role
//   - a CRM/support assistant cannot reach social connectors (and vice-versa)
//   - uncategorised connectors are fail-closed for a scoped role
//   - unknown/custom roles are unrestricted (no policy to apply)
//   - the keyword fallback works when only a display name is available
// Pure logic — no DB required.

import assert from 'node:assert';
import { isServiceAllowedForAssistant, allowedServiceNames, relevantConnectorsForAssistant } from '../src/utils/connection-map';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const SOCIALS = ['Facebook', 'Instagram', 'LinkedIn', 'X'];

check('Social Media Manager may use every social connector', () => {
    const a = { roleKey: 'social_media_manager', role: 'The Social Media Manager' };
    for (const s of SOCIALS) assert.equal(isServiceAllowedForAssistant(s, a), true, s);
});

check('CRM Enricher cannot reach social connectors (sandbox)', () => {
    const a = { roleKey: 'crm_enricher', role: 'The CRM Enricher' };
    assert.equal(isServiceAllowedForAssistant('Facebook', a), false);
    assert.equal(isServiceAllowedForAssistant('LinkedIn', a), false);
});

check('Tier 1 Support Agent cannot reach social connectors', () => {
    const a = { roleKey: 'tier1_support_agent', role: 'The Tier 1 Support Agent' };
    assert.equal(isServiceAllowedForAssistant('Facebook', a), false);
});

check('Scoped role + uncategorised connector is fail-closed', () => {
    const a = { roleKey: 'social_media_manager', role: 'The Social Media Manager' };
    // BambooHR has no category mapping yet → must be denied for a scoped role.
    assert.equal(isServiceAllowedForAssistant('BambooHR', a), false);
});

check('Unknown / custom role is unrestricted', () => {
    const a = { roleKey: 'custom', role: 'My Bespoke Helper' };
    assert.equal(isServiceAllowedForAssistant('Facebook', a), true);
    assert.equal(isServiceAllowedForAssistant('BambooHR', a), true);
});

check('Keyword fallback works from display name when roleKey is missing', () => {
    const a = { roleKey: null, role: 'The Social Media Manager' };
    assert.equal(isServiceAllowedForAssistant('Instagram', a), true);
});

check('allowedServiceNames filters the catalog for the assistant', () => {
    const a = { roleKey: 'social_media_manager', role: 'The Social Media Manager' };
    const result = allowedServiceNames(a, [...SOCIALS, 'BambooHR', 'Salesforce']);
    assert.deepEqual(result.sort(), [...SOCIALS].sort());
});

check('relevantConnectorsForAssistant returns social connectors with no DB rows', () => {
    // Regression: social connectors only become DB rows after OAuth, so the UI must
    // still surface them for a fresh Social Media Manager (was showing "none relevant").
    const a = { roleKey: 'social_media', role: 'The Social Media Manager' };
    const result = relevantConnectorsForAssistant(a);
    assert.deepEqual(result.sort(), ['facebook', 'instagram', 'linkedin', 'twitter', 'x']);
});

check('relevantConnectorsForAssistant excludes social for a CRM role', () => {
    const a = { roleKey: 'crm_enricher', role: 'The CRM Enricher' };
    // No CRM connectors exist in the catalog yet → empty, but crucially no socials.
    assert.equal(relevantConnectorsForAssistant(a).includes('facebook'), false);
});

check('relevantConnectorsForAssistant returns full catalog for unrestricted role', () => {
    const a = { roleKey: 'custom', role: 'My Bespoke Helper' };
    assert.deepEqual(relevantConnectorsForAssistant(a).sort(), ['facebook', 'instagram', 'linkedin', 'twitter', 'x']);
});

console.log(`\n${passed} checks passed.`);
