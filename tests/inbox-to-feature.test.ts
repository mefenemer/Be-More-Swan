// tests/inbox-to-feature.test.ts
// Ideas reach Feature requests from every door: the Inbox (a support request that is really an
// idea → "Send to Feature requests"), and chat (the support card's "feature" destination). The
// person's Contacts record lists their feature requests beside their tickets and issues.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mentorCardFromUiElement } from '../src/utils/mentor-cards';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

console.log('inbox-to-feature');

const card = (destination: unknown) => mentorCardFromUiElement(
    { type: 'mentor_support_request', summary: 's', destination, subject: 'Add Bluesky', description: 'I post there daily.' }, 1) as any;

check('chat card keeps "feature", "issue" and "support"; anything else is support', () => {
    assert.strictEqual(card('feature').destination, 'feature');
    assert.strictEqual(card('issue').destination, 'issue');
    assert.strictEqual(card('support').destination, 'support');
    assert.strictEqual(card('roadmap').destination, 'support');
    assert.strictEqual(card(undefined).destination, 'support');
});

check('both card prompts offer the feature destination', () => {
    assert.ok(read('src/utils/mentor-cards.ts').includes('"destination":"issue"|"support"|"feature"'));
    assert.ok(read('src/constants/assistant-shared-prompts.ts').includes('"destination":"issue"|"support"|"feature"'));
    assert.ok(read('src/utils/discussions.ts').includes('destination "feature", subject "Discussions: add <site>"'));
});

check('the card is drawn as an idea and posts to feature-requests', () => {
    const reg = read('src/components/disruptive-ui-registry.js');
    assert.ok(reg.includes("'Suggest a feature to Be More Swan'"));
    assert.ok(reg.includes('Help & Support ▸ Feature Requests ▸ Your requests'));
    const apply = read('src/components/mentor-apply.js');
    const at = apply.indexOf("d.destination === 'feature'");
    assert.ok(at > 0 && apply.indexOf("/.netlify/functions/feature-requests", at) > at);
    assert.ok(apply.includes("category: 'app_core'"));
});

const inbox = read('src/utils/support-inbox.ts');
const fn = inbox.slice(inbox.indexOf('export async function ticketToFeature'));

check('ticketToFeature: one transaction, pending_review, submitted by the customer, ticket closed with a note', () => {
    assert.ok(fn.startsWith('export async function ticketToFeature') && fn.includes('db.transaction('));
    assert.ok(fn.includes("VALUES (${t.user_id}, ${t.organisation_id}, ${title}, ${description}, ${t.description}, 'app_core', 'pending_review', 'user')"));
    assert.ok(fn.includes('REROUTE_FEATURE_NOTE(feature.id)'));
    assert.ok(fn.includes("UPDATE support_tickets SET status = 'closed'"));
    assert.ok(fn.includes("if (t.status === 'closed') return { ok: false as const, status: 409"));
});

check('likely duplicates are returned, not merged, and the LIKE pattern is escaped', () => {
    assert.ok(fn.includes('possibleDuplicates'));
    assert.ok(!/UPDATE feature_requests/.test(fn), 'never merges on its own');
    assert.ok(fn.includes('title.replace(/[%_\\\\]/g'));
});

check('admin endpoint: tickets only, needs manage_feature_requests, returns duplicates', () => {
    const api = read('netlify/functions/admin-api.ts');
    assert.ok(api.includes("if (toFeature && b.kind !== 'ticket')"));
    assert.ok(api.includes("requirePermission(adminRole, 'manage_feature_requests')"));
    assert.ok(api.includes('possibleDuplicates: r.possibleDuplicates || []'));
});

check('ticket panel offers Send to Feature requests; Contacts lists feature requests', () => {
    const html = read('admin.html');
    assert.ok(html.includes(`onclick="inboxReroute('ticket', \${t.id}, 'feature')"`));
    assert.ok(html.includes('async function inboxRerouteToFeature(id)'));
    assert.ok(html.includes('${_ctFeatureSection(featureIdeas, client)}'));
    assert.ok(html.includes('async function openFeatureRequest(id)'));
    assert.ok(read('netlify/functions/admin-api.ts').includes('featureRequests: featureIdeas'));
});

console.log(`\n${passed} passed`);
