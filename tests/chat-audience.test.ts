// tests/chat-audience.test.ts
// The Email Marketing chat can see the shared Audience and, through cards the user confirms, build a
// rule-based segment or add one contact — the Audience page's own actions.
//
// WHY THIS EXISTS. Every capability is meant to be reachable from the GUI and from chat through one
// server action. The email chat was told it could not see the audience at all. These pin what makes
// the chat path safe: a segment card is built by the rule builder's own preview (its count is the
// real audience of a send); a contact card is refused for anyone already in the audience, anyone who
// opted out, and any address whose opt-out outlived its deleted row; the click goes through
// audience-segments / audience-contacts; and CSV import stays on the page.
//
// Run:  npx tsx tests/chat-audience.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
    contactProposalFromUiElement, refreshAudienceCards, resolveContactProposal, resolveSegmentProposal, segmentProposalFromUiElement,
} from '../src/utils/chat-audience';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

/** A db whose successive select() calls answer with the given row lists, in order. */
function fakeDb(...answers: unknown[][]) {
    const queue = [...answers];
    return {
        select: () => {
            const rows = queue.shift() ?? [];
            const chain: any = {
                from: () => chain, where: () => chain, groupBy: () => chain, orderBy: () => chain,
                limit: () => Promise.resolve(rows),
                then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(rows).then(res, rej),
            };
            return chain;
        },
    } as any;
}
const failingDb = { select: () => { throw new Error('db down'); } } as any;

const JOINED_30 = { match: 'all', conditions: [{ field: 'joined', op: 'within', value: 30 }] };

async function main() {
    console.log('\nThe model\'s proposals are shape-checked');

    await check('a contact proposal normalises the address and reads "#id" segments', () => {
        assert.deepStrictEqual(
            contactProposalFromUiElement({ type: 'audience_contact_proposal', email: '  Jane@Example.COM ', firstName: ' Jane ', segmentId: '#4' }),
            { email: 'jane@example.com', firstName: 'Jane', lastName: null, company: null, segmentId: 4 },
        );
        assert.strictEqual(contactProposalFromUiElement({ type: 'audience_contact_proposal' }), null);
        assert.strictEqual(contactProposalFromUiElement({ type: 'email_action_proposal', email: 'a@b.co' }), null);
    });
    await check('a segment proposal needs a name and a rule object', () => {
        assert.deepStrictEqual(segmentProposalFromUiElement({ type: 'audience_segment_proposal', name: '  New   joiners ', rules: JOINED_30 }),
            { name: 'New joiners', rules: JOINED_30 });
        assert.strictEqual(segmentProposalFromUiElement({ type: 'audience_segment_proposal', name: 'X' }), null);
        assert.strictEqual(segmentProposalFromUiElement({ type: 'audience_segment_proposal', rules: JOINED_30 }), null);
    });

    console.log('\nThe snapshot: counts by status, segments and tags by #id, forms and fields');

    await check('it counts every status, lists by #id, describes rule-based segments, and admits failure', async () => {
        const { buildAudienceSnapshot } = await import('../src/utils/chat-audience');
        const snap = await buildAudienceSnapshot(fakeDb(
            [{ status: 'subscribed', n: 40 }, { status: 'pending', n: 3 }, { status: 'unsubscribed', n: 5 }, { status: 'bounced', n: 2 }],
            [{ id: 4, name: 'VIPs', kind: 'manual', rules: {}, subscribed: 9 },
             { id: 6, name: 'Recent', kind: 'dynamic', rules: JOINED_30, subscribed: 0 },
             { id: 8, name: 'bought', kind: 'tag', rules: {}, subscribed: 11 }],
            [{ id: 2, name: 'Footer form' }],
            [{ key: 'city', label: 'City' }],
        ), 1);
        assert.ok(snap!.includes('40 subscribed (can be emailed), 3 awaiting confirmation, 5 unsubscribed, 2 bounced, marked as spam or suppressed — 50 in total.'), snap!);
        assert.ok(snap!.includes('#4 "VIPs" — hand-picked, 9 subscribed'));
        assert.ok(snap!.includes('#6 "Recent" — rule-based: Everyone subscribed who joined in the last 30 days.'));
        assert.ok(snap!.includes('#8 "bought" — 11 subscribed'), 'tags listed apart');
        assert.ok(snap!.includes('#2 "Footer form"') && snap!.includes('City — key "city"'));
        assert.strictEqual(await buildAudienceSnapshot(failingDb, 1), null);
    });

    console.log('\nA segment card is the rule builder\'s own preview');

    await check('a rule with no conditions is refused before any query — never "everyone"', async () => {
        const card = await resolveSegmentProposal(failingDb, 1, { name: 'All', rules: { match: 'all', conditions: [] } });
        assert.ok(card && /at least one condition/.test(card.blocked || ''), JSON.stringify(card));
        assert.strictEqual(card!.rules, null);
    });
    await check('a valid rule carries the live count, the plain-English rule and the VALIDATED rules', async () => {
        // count, forms, tags, fields (preview) → name-taken check
        const card = await resolveSegmentProposal(fakeDb([{ n: 12 }], [], [], [], []), 1, { name: 'New joiners', rules: JOINED_30 });
        assert.strictEqual(card!.matches, 12);
        assert.strictEqual(card!.description, 'Everyone subscribed who joined in the last 30 days.');
        assert.deepStrictEqual(card!.rules, { match: 'all', conditions: [{ field: 'joined', op: 'within', value: 30 }] });
        assert.strictEqual(card!.blocked, null);
    });
    await check('a name already in use blocks the card (segment names are unique, case-insensitively)', async () => {
        const card = await resolveSegmentProposal(fakeDb([{ n: 3 }], [], [], [], [{ id: 7 }]), 1, { name: 'new joiners', rules: JOINED_30 });
        assert.ok(/already have a segment called/.test(card!.blocked || ''));
    });
    await check('a database failure is no card at all, never a guessed count', async () => {
        assert.strictEqual(await resolveSegmentProposal(failingDb, 1, { name: 'X', rules: JOINED_30 }), null);
    });

    console.log('\nA contact card never re-adds someone who opted out');

    const req = (over = {}) => ({ email: 'jane@example.com', firstName: 'Jane', lastName: null, company: null, segmentId: null, ...over });
    await check('a new address with no opt-out gets a card the user can confirm', async () => {
        const card = await resolveContactProposal(fakeDb([], []), 1, req());
        assert.strictEqual(card!.blocked, null);
        assert.strictEqual(card!.email, 'jane@example.com');
    });
    for (const status of ['unsubscribed', 'bounced', 'complained', 'suppressed', 'subscribed', 'pending']) {
        await check(`an existing ${status} contact is blocked`, async () => {
            const card = await resolveContactProposal(fakeDb([{ status }]), 1, req());
            assert.ok(card!.blocked && card!.blocked.startsWith('jane@example.com '), card!.blocked || 'no block');
        });
    }
    await check('an opt-out kept after the contact was deleted (THE DELETE RULE) blocks it too', async () => {
        const card = await resolveContactProposal(fakeDb([], [{ id: 1 }]), 1, req());
        assert.ok(/asked not to be contacted/.test(card!.blocked || ''));
    });
    await check('an unusable address is blocked without a query', async () => {
        const card = await resolveContactProposal(failingDb, 1, req({ email: 'not-an-email' }));
        assert.ok(/isn’t a valid email address/.test(card!.blocked || ''));
    });
    await check('a rule-based segment is never a target for one contact; a hand-picked one is', async () => {
        const dyn = await resolveContactProposal(fakeDb([{ id: 4, name: 'Recent', kind: 'dynamic' }], [], []), 1, req({ segmentId: 4 }));
        assert.strictEqual(dyn!.segmentId, null);
        const man = await resolveContactProposal(fakeDb([{ id: 5, name: 'VIPs', kind: 'manual' }], [], []), 1, req({ segmentId: 5 }));
        assert.deepStrictEqual([man!.segmentId, man!.segmentName], [5, 'VIPs']);
    });

    console.log('\nReopened conversations re-check stored cards');

    await check('a contact card for someone now in the audience is settled', async () => {
        const [m] = await refreshAudienceCards(fakeDb([{ status: 'subscribed' }]), 1,
            [{ uiElement: { type: 'audience_contact_proposal', email: 'jane@example.com', blocked: null } }]);
        assert.strictEqual((m.uiElement as any).settled, true);
    });
    await check('a segment card whose name now exists is settled', async () => {
        const [m] = await refreshAudienceCards(fakeDb([{ id: 7 }]), 1,
            [{ uiElement: { type: 'audience_segment_proposal', name: 'New joiners', rules: JOINED_30, blocked: null } }]);
        assert.strictEqual((m.uiElement as any).settled, true);
    });
    await check('get-chat-session runs the audience re-check', () => {
        assert.match(read('src/utils/chat-card-refresh.ts'), /await refreshAudienceCards\(db, organisationId, out\)/);
        assert.ok(read('netlify/functions/get-chat-session.ts').includes('refreshStoredCards(db, orgId, session.aiAssistantId, session.roleKey, messages)'));
    });

    console.log('\nWiring: one server path, a consent tick, no import from chat');

    const o = read('netlify/functions/chat-orchestrator.ts');
    await check('the Email route reads the audience per turn and admits when it cannot', () => {
        assert.match(o, /usesAudienceSnapshot: true,/);
        assert.match(o, /const audienceSnapshot = route\.usesAudienceSnapshot \? await buildAudienceSnapshot\(db, orgId\) : null;/);
        assert.ok(o.includes("rc.audienceSnapshot ?? 'YOUR AUDIENCE — the audience could not be read this turn."));
        assert.ok(!o.includes('not their audience, segments, flows'), 'the old "you cannot see the audience" line is gone');
    });
    await check('the prompt keeps CSV import, deletes and resubscribes on the Audience page', () => {
        assert.ok(o.includes('You cannot import a list (that is the "Import CSV" button on the Audience page)'));
        assert.ok(o.includes('Never add someone they describe as a lead, a prospect or a cold contact'));
    });
    await check('proposals are rebuilt server-side and kept, and do not trip the unbacked-claim guard', () => {
        assert.match(o, /audienceCard = segmentReq \? await resolveSegmentProposal\(db, orgId, segmentReq\) : await resolveContactProposal\(db, orgId, contactReq!\);/);
        assert.match(o, /: emailAction \?\? audienceCard \?\? reviewsCard \?\? profileCard;/);
        assert.match(o, /!emailAction && !audienceCard && !reviewsCard && !profileCard\) \{/);
    });
    const cs = read('src/components/chat-session.js');
    const reg = read('src/components/disruptive-ui-registry.js');
    await check('the click calls the Audience page\'s own endpoints, contacts only after the consent tick', () => {
        assert.ok(cs.includes("call('audience-segments', { action: 'create', kind: 'dynamic', name: d.name, rules: d.rules })"));
        assert.ok(cs.includes("if (d.consented !== true) throw new Error('Confirm they agreed to hear from you first.');"));
        assert.ok(cs.includes("action: 'create', via: 'chat', email: d.email"));
        assert.ok(reg.includes("if (!isSegment && !consent?.checked) {"), 'the card refuses without the tick');
        assert.ok(reg.includes("register('audience_segment_proposal', renderAudienceProposalCard);"));
        assert.ok(reg.includes("register('audience_contact_proposal', renderAudienceProposalCard);"));
    });
    await check('a chat-added contact\'s consent record says it came from chat', () => {
        const ac = read('netlify/functions/audience-contacts.ts');
        assert.ok(ac.includes("from the Email Marketing chat, after confirming the person agreed to hear from them."));
    });
    await check('the rule builder and the chat card share one preview', () => {
        assert.ok(read('netlify/functions/audience-segments.ts').includes('const preview = await previewSegmentRules(db, orgId, body.rules);'));
        assert.ok(read('src/utils/chat-audience.ts').includes('await previewSegmentRules(db, organisationId, req.rules)'));
    });

    console.log(`\n${passed}/${total} checks passed`);
    if (passed !== total) process.exitCode = 1;
}

main();
