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
import { isServiceAllowedForAssistant, allowedServiceNames, relevantConnectorsForAssistant, supportedToolsForAssistant, CATEGORY_LABELS, CONNECTOR_CATEGORY, ROLE_CONNECTIONS } from '../src/utils/connection-map';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const SOCIALS = ['Facebook', 'Instagram', 'LinkedIn', 'X'];

check('Social Media Assistant may use every social connector', () => {
    const a = { roleKey: 'social_media_manager', role: 'Social Media Assistant' };
    for (const s of SOCIALS) assert.equal(isServiceAllowedForAssistant(s, a), true, s);
});

check('CRM Enricher cannot reach social connectors (sandbox)', () => {
    const a = { roleKey: 'crm_enricher', role: 'CRM Data Assistant' };
    assert.equal(isServiceAllowedForAssistant('Facebook', a), false);
    assert.equal(isServiceAllowedForAssistant('LinkedIn', a), false);
});

check('Tier 1 Support Agent cannot reach social connectors', () => {
    const a = { roleKey: 'tier1_support_agent', role: 'First-Line Support Assistant' };
    assert.equal(isServiceAllowedForAssistant('Facebook', a), false);
});

check('Blog Writer may use Canva but not social connectors', () => {
    const a = { roleKey: 'blog_writer', role: 'Blog Writing Assistant' };
    // ROLE_CONNECTIONS['blog_writer'] = ['cms', 'search_console', 'knowledge', 'design'].
    // Only 'design' has a connector in CONNECTOR_CATEGORY today (Canva); cms/search_console are
    // served by the separate blog-destinations flow (EXTERNALLY_LIVE_CATEGORIES), so no service
    // name maps to them here.
    assert.equal(isServiceAllowedForAssistant('Canva', a), true);
    // Publishing long-form is not a licence to post socially — the sandbox must hold.
    for (const s of SOCIALS) assert.equal(isServiceAllowedForAssistant(s, a), false, s);
});

check('Blog Writer is explicitly scoped, not fail-open via the name fallback', () => {
    // The display name contains no social keyword, so a MISSING ROLE_CONNECTIONS entry would
    // fall through to the keyword fallback and return unrestricted. Guard that regression.
    const a = { roleKey: 'blog_writer', role: 'Blog Writing Assistant' };
    assert.equal(isServiceAllowedForAssistant('BambooHR', a), false);
});

check('Scoped role + uncategorised connector is fail-closed', () => {
    const a = { roleKey: 'social_media_manager', role: 'Social Media Assistant' };
    // BambooHR has no category mapping yet → must be denied for a scoped role.
    assert.equal(isServiceAllowedForAssistant('BambooHR', a), false);
});

check('Unknown / custom role is unrestricted', () => {
    const a = { roleKey: 'custom', role: 'My Bespoke Helper' };
    assert.equal(isServiceAllowedForAssistant('Facebook', a), true);
    assert.equal(isServiceAllowedForAssistant('BambooHR', a), true);
});

check('Keyword fallback works from display name when roleKey is missing', () => {
    const a = { roleKey: null, role: 'Social Media Assistant' };
    assert.equal(isServiceAllowedForAssistant('Instagram', a), true);
});

check('allowedServiceNames filters the catalog for the assistant', () => {
    const a = { roleKey: 'social_media_manager', role: 'Social Media Assistant' };
    const result = allowedServiceNames(a, [...SOCIALS, 'BambooHR', 'Salesforce']);
    assert.deepEqual(result.sort(), [...SOCIALS].sort());
});

check('relevantConnectorsForAssistant returns social connectors with no DB rows', () => {
    // Regression: social connectors only become DB rows after OAuth, so the UI must
    // still surface them for a fresh Social Media Assistant (was showing "none relevant").
    const a = { roleKey: 'social_media_manager', role: 'Social Media Assistant' };
    const result = relevantConnectorsForAssistant(a);
    // 'design' (Canva) is now in the social role's scope, so canva surfaces alongside the socials.
    assert.deepEqual(result.sort(), ['canva', 'facebook', 'instagram', 'linkedin', 'threads', 'tiktok', 'twitter', 'x', 'youtube']);
});

check('Un-migrated legacy roleKey degrades gracefully via the display-name fallback', () => {
    // The retired 'social_media' key was merged into 'social_media_manager'
    // (db/rolekey-namespace-unification.sql) and is no longer in ROLE_CONNECTIONS.
    // A row that somehow escaped the migration must still resolve its social scope
    // from the display name — never widen to unrestricted, never throw.
    const a = { roleKey: 'social_media', role: 'Social Media Assistant' };
    assert.equal(isServiceAllowedForAssistant('Instagram', a), true);
    assert.equal(isServiceAllowedForAssistant('BambooHR', a), false); // still scoped, not fail-open
    // Display-name fallback grants social + design, so canva surfaces alongside the socials.
    assert.deepEqual(relevantConnectorsForAssistant(a).sort(), ['canva', 'facebook', 'instagram', 'linkedin', 'threads', 'tiktok', 'twitter', 'x', 'youtube']);
});

check('relevantConnectorsForAssistant excludes social for a CRM role', () => {
    const a = { roleKey: 'crm_enricher', role: 'CRM Data Assistant' };
    // No CRM connectors exist in the catalog yet → empty, but crucially no socials.
    assert.equal(relevantConnectorsForAssistant(a).includes('facebook'), false);
});

check('relevantConnectorsForAssistant returns full catalog for unrestricted role', () => {
    const a = { roleKey: 'custom', role: 'My Bespoke Helper' };
    // Full catalog for an unrestricted role now includes canva (the 'design' connector).
    assert.deepEqual(relevantConnectorsForAssistant(a).sort(), ['canva', 'facebook', 'instagram', 'linkedin', 'threads', 'tiktok', 'twitter', 'x', 'youtube']);
});

// ── supportedToolsForAssistant (Connections UI + onboarding summary) ──

check('supportedToolsForAssistant marks Social Media + Design as available for a social role', () => {
    const a = { roleKey: 'social_media_manager', role: 'Social Media Assistant' };
    const tools = supportedToolsForAssistant(a);
    // Both categories have a live connector (socials + Canva), so both are available and
    // sort by label: Design before Social Media.
    assert.deepEqual(tools.map(t => t.key), ['design', 'social']);
    const social = tools.find(t => t.key === 'social')!;
    assert.equal(social.available, true);
    assert.equal(typeof social.label, 'string');
});

check('supportedToolsForAssistant surfaces coming-soon tools for a non-social role', () => {
    const a = { roleKey: 'inbox_manager', role: 'Inbox Assistant' };
    const tools = supportedToolsForAssistant(a);
    assert.deepEqual(tools.map(t => t.key), ['email']);
    assert.equal(tools[0].available, false); // no live email connector yet
});

check('supportedToolsForAssistant lists available tools before coming-soon ones', () => {
    const a = { roleKey: 'review_reputation_manager', role: 'Reputation Management Assistant' };
    const tools = supportedToolsForAssistant(a);
    // reviews (coming soon) + social (available) → social sorts first.
    assert.deepEqual(tools.map(t => t.key), ['social', 'reviews']);
    assert.equal(tools[0].available, true);
    assert.equal(tools[1].available, false);
});

check('supportedToolsForAssistant returns the whole catalogue for an unrestricted role', () => {
    const a = { roleKey: 'custom', role: 'My Bespoke Helper' };
    const tools = supportedToolsForAssistant(a);
    assert.equal(tools.some(t => t.key === 'social' && t.available), true);
    assert.equal(tools.some(t => t.key === 'crm' && !t.available), true);
});

// Guard against drift: every category the policy references must have display
// metadata, otherwise supportedToolsForAssistant silently drops it from the UI.
check('every ROLE_CONNECTIONS category has a CATEGORY_LABELS entry', () => {
    const missing = new Set<string>();
    for (const cats of Object.values(ROLE_CONNECTIONS)) {
        for (const c of cats) if (!CATEGORY_LABELS[c]) missing.add(c);
    }
    assert.equal(missing.size, 0, `categories without a label: ${[...missing].join(', ')}`);
});

check('every live connector category (CONNECTOR_CATEGORY) has a CATEGORY_LABELS entry', () => {
    const missing = new Set<string>();
    for (const c of Object.values(CONNECTOR_CATEGORY)) if (!CATEGORY_LABELS[c]) missing.add(c);
    assert.equal(missing.size, 0, `categories without a label: ${[...missing].join(', ')}`);
});

console.log(`\n${passed} checks passed.`);
