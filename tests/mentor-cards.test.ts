// tests/mentor-cards.test.ts
// The Business Mentor's cards and quiet mode (docs/business-mentor-plan.md §2.3, §3.3, §3.7, §3.13, §14).
// Every capability has a screen AND a chat card through one endpoint; the Mentor can't be paused or
// archived; a suggestion card must say why; the server checks the card before any other route's parser.
//
// Run:  npx tsx tests/mentor-cards.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MENTOR_CARD_TYPES, mentorCardFromUiElement, mentorCardsPromptBlock, proposalKind } from '../src/utils/mentor-cards';

let passed = 0, total = 0;
function test(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}
const root = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

console.log('Business Mentor cards and quiet mode');

test('a Business Information card keeps only known fields, and needs a why', () => {
    const ok = mentorCardFromUiElement({ type: 'mentor_business_profile', summary: 'Fill in your description', why: 'It is empty', fields: { businessDescription: 'Films based on true stories', password: 'x' } }, 50);
    assert.deepStrictEqual(ok && !('error' in ok) && ok.type === 'mentor_business_profile' ? ok.fields : null, { businessDescription: 'Films based on true stories' });
    assert.ok('error' in (mentorCardFromUiElement({ type: 'mentor_business_profile', fields: { industry: 'Film' } }, 50) as object), 'no why');
    assert.ok('error' in (mentorCardFromUiElement({ type: 'mentor_business_profile', why: 'x', fields: {} }, 50) as object), 'nothing to fill');
    assert.ok('error' in (mentorCardFromUiElement({ type: 'mentor_business_profile', why: 'x', fields: { websiteUrl: 'not a url' } }, 50) as object));
});

test('a products card adds product or service only, never a price, at most 8', () => {
    const c = mentorCardFromUiElement({ type: 'mentor_products', why: 'Empty', products: [
        { name: 'Documentary licensing', kind: 'service', price: '£500' }, { name: 'DVD', kind: 'class' }, { name: '' },
        ...Array.from({ length: 10 }, (_, i) => ({ name: `P${i}` })),
    ] }, 50);
    assert.ok(c && !('error' in c) && c.type === 'mentor_products');
    if (c && !('error' in c) && c.type === 'mentor_products') {
        assert.ok(c.products.length <= 8);
        assert.deepStrictEqual(c.products[0], { name: 'Documentary licensing', kind: 'service', description: null });
        assert.strictEqual(c.products[1].kind, 'product');
        assert.ok(!('price' in c.products[0]));
    }
});

test('quiet mode and support cards are the user\'s own requests: no why needed, not counted as suggestions', () => {
    const q = mentorCardFromUiElement({ type: 'mentor_quiet_mode', on: true }, 50);
    assert.deepStrictEqual(q, { type: 'mentor_quiet_mode', summary: '', on: true, assistantId: 50 });
    const s = mentorCardFromUiElement({ type: 'mentor_support_request', destination: 'issue', subject: 'Logged out', description: 'Keeps logging me out' }, 50);
    assert.ok(s && !('error' in s) && s.type === 'mentor_support_request' && s.destination === 'issue');
    assert.strictEqual(proposalKind(q as any), null);
    assert.strictEqual(proposalKind(s as any), null);
    assert.ok('error' in (mentorCardFromUiElement({ type: 'mentor_support_request', subject: 'x' }, 50) as object));
});

test('another route\'s card shape is not a Mentor card', () => {
    assert.strictEqual(mentorCardFromUiElement({ type: 'assistant_settings_proposal', setting: 'pause' }, 50), null);
    assert.strictEqual(mentorCardFromUiElement(null, 50), null);
});

test('the prompt forbids invented prices and says nothing changes until the click', () => {
    const p = mentorCardsPromptBlock();
    assert.match(p, /NEVER invent a price/);
    assert.match(p, /Never say a card has been applied/);
    for (const t of MENTOR_CARD_TYPES) assert.ok(p.includes(`"type":"${t}"`), t);
});

test('the Mentor route is structured and its cards are checked before any other parser', () => {
    const o = read('netlify/functions/chat-orchestrator.ts');
    const route = o.slice(o.indexOf('    business_mentor: {'), o.indexOf('    // Tier 1, Batch 1 — Lead Generator.'));
    assert.ok(route.includes('parseResponse: parseStructuredReply') && route.includes('${mentorCardsPromptBlock()}'));
    const parsed = o.indexOf('let content = parsed.content;');
    const check = o.indexOf('const m = mentorCardFromUiElement(uiElement, session.aiAssistantId);');
    const firstOther = o.indexOf('settingsProposalFromUiElement(uiElement)');
    assert.ok(parsed > 0 && check > parsed && check < firstOther, 'Mentor check must run first');
    assert.match(o.slice(check, check + 1800), /uiElement = null; \/\/ never another route's card shape/);
});

test('every card has a renderer and a click handler that calls the screen\'s own endpoint (§14)', () => {
    const reg = read('src/components/disruptive-ui-registry.js');
    const sess = read('src/components/chat-session.js');
    for (const t of MENTOR_CARD_TYPES) assert.ok(reg.includes(`register('${t}'`), `renderer for ${t}`);
    for (const [ev, endpoint] of [
        ['mentor:businessProfile', '/.netlify/functions/organisation-profile'],
        ['mentor:products', '/.netlify/functions/org-products'],
        ['mentor:quietMode', '/.netlify/functions/update-assistant-context'],
        ['mentor:support', '/.netlify/functions/support-tickets'],
        ['mentor:support', '/.netlify/functions/issue-reports'],
    ]) {
        assert.ok(reg.includes(`eventName: '${ev}'`), `card raises ${ev}`);
        assert.ok(sess.includes(`addEventListener('${ev}'`), `chat listens for ${ev}`);
        assert.ok(sess.includes(endpoint), `${ev} → ${endpoint}`);
    }
});

test('one click saves once, even if the event reaches two listeners', () => {
    const sess = read('src/components/chat-session.js');
    for (const fn of ['onMentorBusinessProfile', 'onMentorProducts', 'onMentorQuietMode', 'onMentorSupport']) {
        assert.match(sess, new RegExp(`async function ${fn}\\(e\\) \\{\\s*\\n\\s*if \\(mentorAlreadyHandled\\(e\\)\\) return;`), fn);
    }
});

test('the Business Information save never sends allowDomainJoin (it would skip the save)', () => {
    const sess = read('src/components/chat-session.js');
    const fn = sess.slice(sess.indexOf('async function onMentorBusinessProfile'), sess.indexOf('async function onMentorProducts'));
    assert.match(fn, /const KEEP = \[/);
    assert.ok(!/KEEP = \[[^\]]*allowDomainJoin/.test(fn));
});

test('the Mentor can\'t be paused or archived, on the server or the page', () => {
    const m = read('netlify/functions/manage-assistant.ts');
    assert.match(m, /action === 'pause' && isWorkspaceRole\(/);
    assert.match(m, /httpMethod === 'DELETE'[\s\S]{0,400}isWorkspaceRole\(/);
    assert.match(read('src/components/assistant-dashboard-registry.js'), /business_mentor: \{[\s\S]{0,900}noPauseOrArchive: true/);
    assert.match(read('assistants.js'), /const lockedIn = !!window\.AssistantDashboardRegistry\?\.get\(currentData\.roleKey\)\?\.noPauseOrArchive;/);
});

test('quiet mode: a set-up answer on its profile that the prompt obeys', () => {
    const schemas = read('src/public/assistant-onboarding-schemas.js');
    assert.match(schemas, /business_mentor: \[[\s\S]*?key: 'quietMode'/);
    const o = read('netlify/functions/chat-orchestrator.ts');
    assert.match(o, /ctx\?\.quietMode === 'on'\s*\n\s*\? 'QUIET MODE IS ON/);
});

console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exit(1);
