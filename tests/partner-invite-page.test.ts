// tests/partner-invite-page.test.ts
// A partner's own invite page (docs/partner-onboarding-plan.md §3.3, Phase 2).
//
// WHY THIS EXISTS (2026-11-23). /invite/<code> can now carry a partner's photo, headline and words.
// It's on OUR domain under our name, so (owner decision D4) nothing goes live until an admin approves
// it, the public page only ever shows the APPROVED version, a pending photo is never public, the page
// says it's a paid partnership, and the words can't carry links, handles, "official" or income claims.
// These tests pin those rules.
//
// Run:  npx tsx tests/partner-invite-page.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    HEADLINE_MAX, PHOTO_MAX_BYTES, QUOTE_MAX, checkJpeg, inviteProfileState, invitePageView, isOwnPhotoKey, newPhotoKey, orphanedKeys, photoUrl, validateInviteText,
} from '../src/utils/partner-invite-profile';
import { proposeInvitePage } from '../src/utils/partner-ops-proposals';
import { getNotificationDefault } from '../src/utils/notification-templates-catalog';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const prof = (headline: string, photoKey: string | null = null) => ({ headline, quote: '', photoKey, submittedAt: '2026-11-23T00:00:00Z' });

console.log('the words');

check('a normal headline and quote pass, tidied', () => {
    const r = validateInviteText({ headline: '  Why I use Be More Swan  ', quote: 'It writes my posts\n so I can   make films.' });
    assert.deepStrictEqual(r, { ok: true, headline: 'Why I use Be More Swan', quote: 'It writes my posts so I can make films.' });
});

check('length limits and a missing headline are refused', () => {
    assert.ok(!validateInviteText({ headline: 'Hi', quote: '' }).ok);
    assert.ok(!validateInviteText({ headline: 'x'.repeat(HEADLINE_MAX + 1) }).ok);
    assert.ok(!validateInviteText({ headline: 'Fine headline', quote: 'y'.repeat(QUOTE_MAX + 1) }).ok);
    assert.ok(validateInviteText({ headline: 'x'.repeat(HEADLINE_MAX), quote: 'y'.repeat(QUOTE_MAX) }).ok);
});

check('no links, web addresses or @handles (they would send our visitors elsewhere)', () => {
    for (const bad of ['See https://me.example', 'Visit www.kudzu', 'Find me at kudzucollab.com', 'Follow @kudzucollab', 'mysite.co.uk is great']) {
        assert.ok(!validateInviteText({ headline: 'Why I use it', quote: bad }).ok, bad);
    }
});

check('nothing official-looking or promising income (Partner Terms 5.2)', () => {
    for (const bad of ['The official Be More Swan page', 'Guaranteed more clients', 'Risk-free growth', 'Earn passive income', 'I am 100% sure', '100 % better']) {
        assert.ok(!validateInviteText({ headline: bad }).ok, bad);
    }
});

console.log('the photo');

check('only a small JPEG is accepted (the page re-encodes every photo)', () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400)]);
    assert.ok(checkJpeg(jpeg.toString('base64')).ok);
    assert.ok(checkJpeg('data:image/jpeg;base64,' + jpeg.toString('base64')).ok);
    assert.ok(!checkJpeg(Buffer.concat([Buffer.from('<svg'), Buffer.alloc(400)]).toString('base64')).ok, 'not an SVG');
    assert.ok(!checkJpeg(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(400)]).toString('base64')).ok, 'not a PNG');
    assert.ok(!checkJpeg(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(PHOTO_MAX_BYTES)]).toString('base64')).ok, 'not too big');
    assert.ok(!checkJpeg('not base64 !!').ok);
});

check('photo keys are random, per partner, and a key from a request is never trusted', () => {
    const k = newPhotoKey(7);
    assert.ok(isOwnPhotoKey(7, k));
    assert.ok(!isOwnPhotoKey(8, k), 'another partner’s key');
    assert.ok(!isOwnPhotoKey(7, 'partner-photos/7/../../secret.jpg'));
    assert.notStrictEqual(newPhotoKey(7), k);
    assert.strictEqual(photoUrl(7, k), `/.netlify/functions/partner-photo?p=7&k=${String(k).split('/').pop()}`);
    assert.strictEqual(photoUrl(7, null), null);
});

check('old photos nobody points at are cleaned up; ones still used are kept', () => {
    assert.deepStrictEqual(orphanedKeys(['a', 'b'], ['b']), ['a']);
    assert.deepStrictEqual(orphanedKeys(['a', null], [null, 'a']), []);
    assert.deepStrictEqual(orphanedKeys(['a', 'a'], []), ['a']);
});

console.log('review states');

check('state: none → waiting → changes requested / live', () => {
    assert.strictEqual(inviteProfileState({ inviteProfile: null, inviteProfilePending: null, inviteProfileNote: null }), 'none');
    assert.strictEqual(inviteProfileState({ inviteProfile: null, inviteProfilePending: prof('A'), inviteProfileNote: null }), 'waiting');
    assert.strictEqual(inviteProfileState({ inviteProfile: null, inviteProfilePending: prof('A'), inviteProfileNote: 'Use a photo of you' }), 'changes_requested');
    assert.strictEqual(inviteProfileState({ inviteProfile: prof('A'), inviteProfilePending: null, inviteProfileNote: null }), 'live');
    assert.strictEqual(inviteProfileState({ inviteProfile: prof('A'), inviteProfilePending: prof('B'), inviteProfileNote: null }), 'waiting', 'an edit waits; the live one stays');
});

check('admin view shows both versions with photo URLs', () => {
    const v = invitePageView({ id: 3, invite_profile: prof('Live one', 'partner-photos/3/aaaaaaaaaaaaaaaaaaaaaaaa.jpg'), invite_profile_pending: prof('New one'), invite_profile_note: null });
    assert.strictEqual(v.state, 'waiting');
    assert.strictEqual(v.live?.headline, 'Live one');
    assert.ok(v.live?.photoUrl?.includes('p=3&k=aaaaaaaaaaaaaaaaaaaaaaaa.jpg'));
    assert.strictEqual(v.pending?.photoUrl, null);
});

check('Partner Ops cards: approve / changes only for a waiting page; changes need a note; approve needs an approved partner', () => {
    const list = [
        { id: 1, status: 'approved', name: 'Angela', email: null, invitePageState: 'waiting' as const, headline: 'Why I use it' },
        { id: 2, status: 'approved', name: 'Sam', email: null, invitePageState: 'live' as const, headline: 'X' },
        { id: 3, status: 'suspended', name: 'Jo', email: null, invitePageState: 'waiting' as const, headline: 'Y' },
        { id: 4, status: 'approved', name: 'Ali', email: null, invitePageState: 'waiting' as const, headline: 'Z', hasLive: false },
        { id: 5, status: 'approved', name: 'Bo', email: null, invitePageState: 'waiting' as const, headline: 'W', hasLive: true },
    ];
    assert.ok('error' in proposeInvitePage(list, { partnerId: 4, decision: 'take_down' }), 'nothing live → no take-down card');
    assert.ok('card' in proposeInvitePage(list, { partnerId: 5, decision: 'take_down' }), 'an edit waiting over a live page → can take down');
    const ok = proposeInvitePage(list, { partnerId: 1, decision: 'approve' });
    assert.ok('card' in ok && ok.card.request.action === 'invite_page' && (ok.card.request as any).decision === 'approve');
    assert.ok('error' in proposeInvitePage(list, { partnerId: 1, decision: 'changes' }), 'note required');
    assert.ok('card' in proposeInvitePage(list, { partnerId: 1, decision: 'changes', note: 'Use a photo of you' }));
    assert.ok('error' in proposeInvitePage(list, { partnerId: 2, decision: 'approve' }), 'nothing waiting');
    assert.ok('card' in proposeInvitePage(list, { partnerId: 2, decision: 'take_down' }));
    assert.ok('error' in proposeInvitePage(list, { partnerId: 3, decision: 'approve' }), 'not while suspended');
    assert.ok('error' in proposeInvitePage(list, { partnerId: 9, decision: 'approve' }));
});

console.log('wiring');

check('public page shows ONLY the approved version, only for an approved partner, labelled as a paid partnership', () => {
    const lookup = read('netlify/functions/invite-lookup.ts');
    assert.ok(lookup.includes('live: partners.inviteProfile'), 'reads the approved column');
    assert.ok(!lookup.includes('inviteProfilePending'), 'never the pending one');
    assert.ok(lookup.includes("eq(partners.status, 'approved')"));
    const page = read('invite.html');
    assert.ok(page.includes('Paid partnership · ${d.firstName} is a Be More Swan partner and earns a commission if you join'));
    assert.ok(page.includes("'Paid partnership · The person who shared this link is a Be More Swan partner"), 'no "They is" without a first name');
    assert.ok(page.includes("document.getElementById('inv-title').textContent = d.profile.headline"), 'their words as text, never HTML');
    assert.ok(!/innerHTML\s*=\s*[^;]*d\.profile/.test(page));
});

check('a pending photo is never public: partner or partner admin only, never while impersonating', () => {
    const fn = read('netlify/functions/partner-photo.ts');
    assert.ok(fn.includes("if (p.live?.photoKey === key && p.status === 'approved') isPublic = true;"));
    assert.ok(fn.includes("requirePermission(u?.role, 'manage_partners')"));
    assert.ok(fn.includes("tok.scope === 'impersonate' ? null"));
    assert.ok(fn.includes("'private, no-store'"));
    assert.ok(fn.includes('/^[a-f0-9]{24}\\.jpg$/'), 'file name shape checked before any lookup');
});

check('partner side: Terms first, approved only, rate-limited, nothing goes live on submit', () => {
    const hub = read('netlify/functions/partner-hub.ts');
    const block = hub.slice(hub.indexOf("body.action === 'invite_profile_submit' || body.action === 'invite_profile_withdraw'"), hub.indexOf("body.action === 'cancel_payout_change'"));
    assert.ok(block.includes("if (p.status !== 'approved') return json(403"));
    assert.ok(block.includes('if (!acceptedForUse(p)) return json(403'))  // accepted since approval (owner 2026-11-24);
    assert.ok(block.includes("checkRateLimit(db, 'partner_invite_profile'"));
    assert.ok(block.includes('inviteProfilePending: next') && !block.includes('inviteProfile: next'), 'submit only fills pending');
    assert.ok(hub.indexOf("if (impersonating) return json(403") < hub.indexOf("body.action === 'invite_profile_submit'"), 'blocked while impersonating');
    assert.ok(block.includes('.where(unchanged)') && (block.match(/\.where\(unchanged\)/g) || []).length === 2, 'both saves conditional (no deleting a photo that just went live)');
    assert.ok(block.includes('if (!done.length) return changedMeanwhile;') && block.includes('if (!saved.length) {'));
});

check('admin side: approve copies pending → live; changes keeps it pending with a note; conditional update; partner told', () => {
    const adm = read('netlify/functions/admin-partners.ts');
    assert.ok(adm.includes('set = { inviteProfile: pending, inviteProfilePending: null, inviteProfileNote: null };'));
    assert.ok(adm.includes('set = { inviteProfileNote: note };'));
    assert.ok(adm.includes('IS NOT DISTINCT FROM'), 'no crossing over with a resend');
    assert.ok(adm.includes("await audit('partner_decision', partnerId"));
    for (const k of ['partner_invite_page_live', 'partner_invite_page_changes', 'partner_invite_page_removed']) assert.ok(getNotificationDefault(k), k);
    assert.ok(read('netlify/functions/admin-partners-chat.ts').includes("case 'propose_invite_page'"), 'chat path too (GUI + chat parity)');
});

check('assistant card only FILLS the form; the partner sends it', () => {
    const asst = read('netlify/functions/partner-assistant.ts');
    assert.ok(asst.includes("cards.push({ kind: 'invite_page', headline: checked.headline, quote: checked.quote })"));
    assert.ok(asst.includes('validateInviteText({ headline: input.headline, quote: input.quote })'), 'same rules as the form');
    const page = read('partner-content.html');
    assert.ok(page.includes('function fillInvitePage(headline, quote)') && page.includes('Nothing is sent until you press Send for review.'));
});

check('erasure removes the invite page and its photos', () => {
    const er = read('src/utils/partner-erasure.ts');
    assert.ok(er.includes('inviteProfile: null, inviteProfilePending: null, inviteProfileNote: null'));
    assert.ok(er.includes('await deleteAllPhotos(partnerId)'), 'the whole folder, not just the photos the row points at');
});

check('SQL and schema agree; partner kit only lists files under /partner-kit/', () => {
    const sql = read('db/z-partner-invite-page.sql');
    for (const c of ['invite_profile jsonb', 'invite_profile_pending jsonb', 'invite_profile_note text', 'invite_profile_reviewed_at timestamp']) assert.ok(sql.includes(`ADD COLUMN IF NOT EXISTS ${c}`), c);
    const schema = read('db/schema.ts');
    for (const c of ['inviteProfile: jsonb("invite_profile")', 'inviteProfilePending: jsonb("invite_profile_pending")', 'inviteProfileNote: text("invite_profile_note")']) assert.ok(schema.includes(c), c);
    assert.ok(read('partner-content.html').includes("x.url.startsWith('/partner-kit/')"));
    assert.deepStrictEqual(JSON.parse(read('partner-kit/kit.json')).items, []);
});

console.log(`\n${passed} passed`);
