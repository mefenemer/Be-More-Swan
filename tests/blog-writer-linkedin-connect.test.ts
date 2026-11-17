// tests/blog-writer-linkedin-connect.test.ts
// The Blog Writer's "Connect LinkedIn" card (its LinkedIn blog destination) was refused by the
// OAuth callback with "LinkedIn isn't a relevant connection for this assistant" (2026-11-17).
// It may now CONNECT LinkedIn — and only LinkedIn — without the social grid joining its
// Connections tab, and the connection goes to the workspace pool, not to the Blog Writer.
//
// Run:  npx tsx tests/blog-writer-linkedin-connect.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
    isServiceAllowedForAssistant, isConnectAllowedForAssistant, connectViaBlogDestination,
    relevantConnectorsForAssistant, allowedServiceNames, ROLE_CONNECT_ONLY_SERVICES,
} from '../src/utils/connection-map';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const src = (p: string) => readFileSync(p, 'utf8');

const blog = { roleKey: 'blog_writer', role: 'Blog Writer' };
const smm = { roleKey: 'social_media_manager', role: 'Social Media Manager' };

check('Blog Writer may connect LinkedIn (either case)', () => {
    assert.equal(isConnectAllowedForAssistant('linkedin', blog), true);
    assert.equal(isConnectAllowedForAssistant('LinkedIn', blog), true);
    assert.equal(connectViaBlogDestination('linkedin', blog), true);
});

check('Blog Writer still may NOT connect any other social account', () => {
    for (const s of ['facebook', 'instagram', 'x', 'threads', 'tiktok', 'youtube']) {
        assert.equal(isConnectAllowedForAssistant(s, blog), false, s);
    }
});

check('Blog Writer grid is unchanged: no social card appears', () => {
    assert.equal(isServiceAllowedForAssistant('linkedin', blog), false);
    assert.ok(!relevantConnectorsForAssistant(blog).includes('linkedin'));
    assert.deepEqual(allowedServiceNames(blog, ['linkedin', 'facebook']), []);
});

check('Social Media Manager is untouched and never goes through the pool route', () => {
    assert.equal(isConnectAllowedForAssistant('linkedin', smm), true);
    assert.equal(connectViaBlogDestination('linkedin', smm), false);
});

check('Other no-social roles stay blocked (Video Producer, Website, Mentor)', () => {
    for (const roleKey of ['video_producer', 'website_assistant', 'business_mentor', 'campaign_orchestrator']) {
        assert.equal(isConnectAllowedForAssistant('linkedin', { roleKey }), false, roleKey);
    }
});

check('Connect-only list holds only the Blog Writer → LinkedIn', () => {
    assert.deepEqual(ROLE_CONNECT_ONLY_SERVICES, { blog_writer: ['linkedin'] });
});

const callback = src('netlify/functions/social-oauth-callback.ts');

check('Callback checks with isConnectAllowedForAssistant, not the grid rule', () => {
    assert.ok(callback.includes('!isConnectAllowedForAssistant(service, assistant)'));
    assert.ok(!callback.includes('isServiceAllowedForAssistant('));
});

check('Callback binds a blog-destination connection to the pool (assistantId = null)', () => {
    assert.ok(callback.includes('if (connectViaBlogDestination(service, assistant)) { assistantId = null; viaBlogDestination = true; }'));
});

check('Every callback redirect returns to the page the person started on', () => {
    assert.ok(!callback.includes("${assistantId ? `&assistantId=${assistantId}` : ''}"));
    assert.ok(callback.includes("${returnAssistantId ? `&assistantId=${returnAssistantId}` : ''}"));
});

check('Company Page pick carries the return page through', () => {
    assert.ok(callback.includes('assistantId, returnAssistantId, enableBlogDestination: viaBlogDestination, pages,'));
    const pick = src('netlify/functions/linkedin-page-pick.ts');
    assert.equal(pick.split('pending.returnAssistantId ?? pending.assistantId').length - 1, 2);
});

check('integrations POST uses the connect rule too', () => {
    assert.ok(src('netlify/functions/integrations.ts').includes('!isConnectAllowedForAssistant(serviceName, assistant)'));
});

check('Member reconnect clean-up uses the connection\'s own assistant first', () => {
    assert.ok(callback.includes('assistantId: existing.assistantId ?? assistantId,'));
    assert.ok(callback.includes('const [existing] = await db.select({ id: systemConnections.id, assistantId: systemConnections.assistantId })'));
});

check('Blog Writer sign-in switches the LinkedIn blog destination on (no second click)', () => {
    assert.equal(callback.split('if (viaBlogDestination) await optInLinkedInBlogDestination(db, organisationId);').length - 1, 2);
    assert.ok(callback.includes('enableBlogDestination: viaBlogDestination,'));
    assert.ok(src('netlify/functions/linkedin-page-pick.ts').includes('if (pending.enableBlogDestination) await optInLinkedInBlogDestination(db, organisationId);'));
    const optin = src('src/utils/blog-linkedin-optin.ts');
    assert.ok(optin.includes("connectSocialBlogDestination(db as never, organisationId, 'linkedin')"));
    assert.ok(optin.includes('catch (err)'), 'opt-in must never fail the sign-in');
});

console.log(`\n${passed} passed`);
