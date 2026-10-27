// tests/mentor-overview-consistency.test.ts
// The Business Mentor's Overview tab must agree with itself. Each test is one contradiction found on
// staging, 27 Oct, on Nova's Overview ("Week of 26 Oct" review beside the panels):
//
//   1. The review called the free trial the main gap the day after "Change Marvin's Incentive or offer to
//      your free 14-day trial" was accepted — two different settings, never explained; and the set-up
//      checklist showed everything done.
//   2. "Add an email signature to Zaphod's outreach" waited for an answer after Catherine's signature on the
//      same emails was accepted.
//   3. The review praised "your first review, 5/5"; the Customers panel said no reviews were added.
//   4–7, 12. Dex listed as producing with 0; "0 of 1 by 30 September" a month after; a headline the body
//      called "not a trend"; an at-risk goal under "What went well"; "items"; drafts waiting assumed.
//   8. "101 leads this week" vs "Find 300 Leads 16 of 300", and the review asked the owner to find out why.
//   9. Four accepted yesterday + two waiting beside "2 of 3 used".
//   10. Overdue invoices credited to the Support Agent.
//   11. "I" and "Nova" mixed on one page.
//
// Run:  npx tsx tests/mentor-overview-consistency.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
    ACCEPTED_HOLD_DAYS, acceptedMatch, gateSuggestion, isSameChange, renderProposalState, REPEATABLE_KINDS, type ProposalState,
} from '../src/utils/mentor-proposals';
import { contentFindings, renderContentChecksForMentor, type ContentCheckInputs } from '../src/utils/mentor-content-checks';
import { goalNotes, setupChecklist, type MentorSnapshotData } from '../src/utils/mentor-snapshot';
import { renderCustomersForMentor, reviewsNote, type CustomersView } from '../src/utils/mentor-customers';
import { renderFigures, REVIEW_CONSISTENCY_RULES, weekBeforeBreakdown, type AssistantFigures } from '../src/utils/mentor-review';
import { sinceLine } from '../src/utils/mentor-outcomes';
import { mentorVisibility } from '../src/config/mentor-data-inventory';

let passed = 0, total = 0;
function test(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}
const root = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

const NOW = new Date('2026-10-27T10:00:00Z');
const data = (over: Partial<MentorSnapshotData> = {}): MentorSnapshotData => ({
    business: { description: 'Marketing agency', industry: 'Marketing', website: 'https://example.test' },
    products: [{ name: 'Retainer', hasPrice: true }], productCount: 1, offerKinds: ['services'], introOfferAnswered: true, introOfferHas: true,
    team: [{ id: 2, name: 'Marvin', role: 'Social Media Assistant', state: 'active', roleKey: 'social_media_manager', setup: { incentive: 'Free 14-day trial' } }],
    goals: [], plan: { status: 'active', freeSlots: null }, ...over,
});
const state = (over: Partial<ProposalState> = {}): ProposalState => ({ usedThisWeek: 0, dismissed: [], accepted: [], ...over });

console.log('mentor overview — one page that agrees with itself');

// ── 2. An accepted change is never suggested again ───────────────────────────────────────────────
test('an accepted set-up change holds back the same change; a direct ask still draws it', () => {
    const s = state({ accepted: [{ kind: 'setup_field', title: "Add Catherine's email signature to Zaphod's outreach emails.", fields: ['9:signature'], decidedAt: new Date('2026-10-26') }] });
    const g = gateSuggestion({ kind: 'setup_field', fields: ['9:signature'], asked: false, title: 'Add an email signature to Zaphod’s outreach' }, s, NOW);
    assert.ok(!g.ok && g.why === 'accepted', 'held back');
    assert.match((g as { note: string }).note, /already accepted/);
    assert.ok(gateSuggestion({ kind: 'setup_field', fields: ['9:signature'], asked: true }, s, NOW).ok, 'asked always may');
    assert.ok(gateSuggestion({ kind: 'setup_field', fields: ['9:follow_up'], asked: false }, s, NOW).ok, 'a different question is not held');
    assert.ok(gateSuggestion({ kind: 'setup_field', fields: ['4:signature'], asked: false }, s, NOW).ok, 'another assistant is not held');
    assert.ok(ACCEPTED_HOLD_DAYS >= 30);
});

test('new work is never held back by an accepted one (post requests, plan revisions)', () => {
    assert.ok(REPEATABLE_KINDS.includes('draft_request') && REPEATABLE_KINDS.includes('strategy_revision'));
    const s = state({ accepted: [{ kind: 'draft_request', title: 'A post for Marvin', fields: ['2:post'], decidedAt: NOW }] });
    assert.ok(gateSuggestion({ kind: 'draft_request', fields: ['2:post'], asked: false }, s, NOW).ok);
    assert.ok(!isSameChange({ kind: 'draft_request', payload: { fields: { '2:post': true } } }, { kind: 'draft_request', payload: { fields: { '2:post': true } } }));
});

test('kinds without fields match only the same title', () => {
    const acc = [{ kind: 'hire_recommendation', title: 'Hire a Support Agent', fields: [], decidedAt: NOW }];
    assert.ok(acceptedMatch('hire_recommendation', [], acc, 'hire a support agent'));
    assert.equal(acceptedMatch('hire_recommendation', [], acc, 'Hire a Bookkeeper'), null);
    assert.equal(acceptedMatch('hire_recommendation', [], acc), null);
});

test('accepting one expires the other open cards for the same change', () => {
    assert.ok(isSameChange({ kind: 'setup_field', payload: { fields: { '9:signature': 'Catherine' } } }, { kind: 'setup_field', payload: { fields: { '9:signature': 'Best' } } }));
    assert.ok(!isSameChange({ kind: 'setup_field', payload: { fields: { '9:signature': 'x' } } }, { kind: 'business_info_gap', payload: { fields: { '9:signature': 'x' } } }));
    const src = read('src/utils/mentor-proposals.ts');
    const decide = src.slice(src.indexOf('export async function decideProposal'), src.indexOf('export function isSameChange'));
    assert.match(decide, /decision === 'accepted'\) await expireSameChange\(/);
});

test('the prompt lists what is already accepted as done', () => {
    const txt = renderProposalState(state({ accepted: [{ kind: 'setup_field', title: "Change Marvin's offer", fields: ['2:incentive'], decidedAt: new Date('2026-10-26T09:00:00Z') }] }), NOW);
    assert.match(txt, /ALREADY ACCEPTED/);
    assert.match(txt, /Change Marvin's offer \(accepted 26 Oct\)/);
});

test('the review passes the title to the gate', () => {
    assert.match(read('src/utils/mentor-review.ts'), /gateSuggestion\(\{ kind: d\.kind, fields: d\.fields, asked: false, title: d\.title \}/);
});

// ── 1. The offer vs the call to action ───────────────────────────────────────────────────────────
const checks = (over: Partial<ContentCheckInputs> = {}): ContentCheckInputs => ({
    ctas: [{ name: 'Marvin', chosen: 'own', resolved: { kind: 'own' }, incentive: 'Free 14-day trial' }, { name: 'Lyra', chosen: 'own', resolved: { kind: 'own' }, incentive: null }],
    offer: 'Free 14-day trial.', goals: [], services: [], knowledge: [], hasApprovedPlan: false, ...over,
});

test('the finding explains that "Incentive or offer" is not the call to action', () => {
    const f = contentFindings(checks());
    assert.equal(f.length, 1);
    assert.match(f[0].text, /none of your content assistants uses it as its call to action/);
    assert.match(f[0].text, /Marvin mentions an offer in its "Incentive or offer" answer, but that only adds a detail to posts/);
    assert.equal(f[0].where, 'Business Information ▸ Products & Services ▸ Calls to action');
    assert.doesNotMatch(contentFindings(checks({ ctas: [{ name: 'Lyra', chosen: 'own', resolved: { kind: 'own' }, incentive: '' }] }))[0].text, /Incentive or offer/);
});

test('the prompt is told never to fix the call to action through "Incentive or offer"', () => {
    const lines = renderContentChecksForMentor(checks()).join('\n');
    assert.match(lines, /"Incentive or offer" is NOT the call to action/);
    assert.doesNotMatch(renderContentChecksForMentor(checks({ offer: null })).join('\n'), /Incentive or offer" is NOT/);
});

test('the checklist shows "Your offer as a call to action" when an offer is recorded', () => {
    const item = setupChecklist(data()).find((i) => i.key === 'offer_cta');
    assert.ok(item && !item.done, 'shown, not done: 6 of 6 hid the gap the review raised');
    assert.equal(item!.tab, 'products');
    const set = data({ team: [{ id: 2, name: 'Marvin', role: 'Social', state: 'active', roleKey: 'social_media_manager', setup: { ctaOffer: 'intro_offer' } }] });
    assert.ok(setupChecklist(set).find((i) => i.key === 'offer_cta')!.done);
    assert.equal(setupChecklist(data({ introOfferHas: false })).find((i) => i.key === 'offer_cta'), undefined, 'no offer, no row');
    assert.equal(setupChecklist(data({ team: [{ id: 3, name: 'Zaphod', role: 'Leads', state: 'active', roleKey: 'lead_qualifier' }] })).find((i) => i.key === 'offer_cta'), undefined, 'no content assistant, no row');
    assert.equal(setupChecklist(data({ team: [{ id: 2, name: 'Marvin', role: 'Social', state: 'paused_by_user', roleKey: 'social_media_manager' }] })).find((i) => i.key === 'offer_cta'), undefined, 'paused ones are not checked');
});

// ── 3. Reviews: one source ───────────────────────────────────────────────────────────────────────
const customers = (over: Partial<CustomersView> = {}): CustomersView => ({
    sources: [{ key: 'reviews', label: 'Customer reviews', available: false, note: '' }], deals: { won: 0, lost: 0, disqualified: 0, lossReasons: [], enough: false },
    quiet: [], reviews: null, tickets: null, overdueInvoices: null, reviewsPending: 0, ...over,
});

test('reviews are counted as Audience ▸ Reviews counts them, and pending ones are named', () => {
    const src = read('src/utils/mentor-customers.ts');
    assert.match(src, /inArray\(orgReviews\.status, \[\.\.\.COUNTED_STATUSES\]\)/);
    assert.doesNotMatch(src, /eq\(orgReviews\.status, 'published'\)/);
    assert.equal(reviewsNote(0, 0), 'No reviews have been added yet.');
    assert.equal(reviewsNote(0, 1), 'None approved yet — 1 sent in by customers is waiting for your approval in Audience ▸ Reviews.');
    assert.equal(reviewsNote(3, 2), 'From Audience ▸ Reviews. 2 sent in by customers are waiting for your approval in Audience ▸ Reviews.');
});

test('the prompt says this block is the only source of reviews, with or without any', () => {
    const empty = renderCustomersForMentor(customers()).join('\n');
    assert.match(empty, /ONLY source of customer reviews/);
    const pending = renderCustomersForMentor(customers({ reviewsPending: 1 })).join('\n');
    assert.match(pending, /waiting for their approval in Audience ▸ Reviews: 1 \(not approved, so not counted/);
    const some = renderCustomersForMentor(customers({ reviews: { count: 2, average: 4.5, low: [] }, sources: [{ key: 'reviews', label: 'Customer reviews', available: true, note: '' }] })).join('\n');
    assert.match(some, /ONLY source of customer reviews/);
    assert.match(some, /Reviews: 2, average 4\.5\/5/);
});

// ── 5, 8. Goals: what they count, and a date that has passed ─────────────────────────────────────
test('a goal says what it counts, so a figure and a goal that differ can be explained', () => {
    const n = goalNotes({ latest: 16, target: 300, targetDate: new Date('2026-10-30'), metricKey: 'qualified_leads' }, NOW);
    assert.match(n, /counts: Leads you have cleared for outreach right now/);
    assert.doesNotMatch(n, /DATE PASSED/);
});

test('a goal whose date passed unmet is "missed", never "by" that date', () => {
    const n = goalNotes({ latest: 0, target: 1, targetDate: new Date('2026-09-30'), metricKey: null }, NOW);
    assert.match(n, /DATE PASSED 27 days ago/);
    assert.match(n, /"missed on 30 September" \(never "by 30 September"\)/);
    assert.equal(goalNotes({ latest: 1, target: 1, targetDate: new Date('2026-09-30'), metricKey: null }, NOW), '', 'a met goal is not missed');
    assert.equal(goalNotes({ latest: null, target: 1, targetDate: new Date('2026-10-30'), metricKey: null }, NOW), '');
});

test('the review\'s goal lines carry those notes; the chat snapshot\'s too', () => {
    const lines = renderFigures([], data({ goals: [{ assistant: 'Dex', label: 'Newsletter', latest: 0, target: 1, targetDate: new Date('2026-09-30'), status: 'at_risk' }] }), NOW).join('\n');
    assert.match(lines, /- Dex: Newsletter 0\/1 by 2026-09-30 \(at risk\) — DATE PASSED/);
    assert.match(lines, /never ask the user to find out why/);
    assert.match(read('src/utils/mentor-snapshot.ts'), /\(\$\{g\.status\.replace\(\/_\/g, ' '\)\}\)\$\{goalNotes\(g\)\}/);
});

// ── 4, 12. Figures: units both weeks, and drafts waiting ─────────────────────────────────────────
const fig = (over: Partial<AssistantFigures> = {}): AssistantFigures => ({ id: 5, name: 'Finn', role: 'Social Media Assistant', thisWeek: 0, lastWeek: 10, enough: true, breakdown: '', ...over });

test('a drop to 0 still says what the work was', () => {
    const b = weekBeforeBreakdown([{ key: 'posts', label: 'Social posts drafted', count: 2 }], [{ key: 'posts', label: 'Social posts drafted', count: 12 }, { key: 'blog', label: 'Blog posts written', count: 0 }]);
    assert.deepEqual(b.map((x) => [x.key, x.count]), [['posts', 10]]);
    const line = renderFigures([fig({ lastBreakdown: '10 social posts drafted' })], data(), NOW).join('\n');
    assert.match(line, /Finn \(Social Media Assistant, assistantId 5\): 0 this week, 10 the week before \(10 social posts drafted\)/);
});

test('posts waiting for review are a figure, not a guess', () => {
    const line = renderFigures([fig({ name: 'Marvin', thisWeek: 24, breakdown: '24 social posts drafted', awaitingReview: 7 })], data(), NOW).join('\n');
    assert.match(line, /24 this week \(24 social posts drafted\), 10 the week before; 7 posts waiting for your review now/);
    assert.doesNotMatch(renderFigures([fig({ awaitingReview: null })], data(), NOW).join('\n'), /waiting for your review/);
});

test('the review prompt carries the consistency rules', () => {
    for (const re of [/figure THIS WEEK is above 0/, /never "items"/, /"not a trend yet" is never a headline/, /"What went well" holds only good news/,
        /DATE PASSED is missed/, /"counts:" line\. Never ask the user/, /ALREADY ACCEPTED is done/, /"waiting for your review now"/, /won, lost and disqualified/]) {
        assert.match(REVIEW_CONSISTENCY_RULES, re);
    }
    assert.match(read('src/utils/mentor-review.ts'), /MENTOR_REVIEW_CRAFT, MENTOR_HONESTY_RULES, REVIEW_CONSISTENCY_RULES,/);
});

// ── 9. Track record: when it was suggested ───────────────────────────────────────────────────────
test('the track record says when a suggestion was made, and "too early" once', () => {
    const base = { title: "Change Marvin's offer", measureLabel: null, before: null, after: null, acceptedAt: new Date('2026-10-26T09:00:00Z') };
    assert.equal(sinceLine({ ...base, suggestedAt: new Date('2026-10-20T09:00:00Z') }, 'too_early', NOW), "Change Marvin's offer — suggested 20 Oct, accepted 1 day ago. Too early to tell.");
    assert.equal(sinceLine({ ...base, suggestedAt: new Date('2026-10-26T08:00:00Z') }, 'too_early', NOW), "Change Marvin's offer — accepted 1 day ago. Too early to tell.", 'same day: said once');
    const ui = read('src/components/assistant-mentor-overview.js');
    assert.match(ui, /I look at each one again a week after you accept it\./);
    assert.match(ui, /used since Monday/);
    assert.match(ui, /nor does answering one from an earlier week/);
    assert.match(read('src/utils/mentor-outcomes.ts'), /leftJoin\(mentorProposals, eq\(mentorProposals\.id, mentorOutcomes\.proposalId\)\)/);
});

// ── 10. Overdue invoices belong to Accounts Receivable ───────────────────────────────────────────
test('"What I can see" credits overdue invoices to Accounts Receivable', () => {
    const sees = mentorVisibility().sees.join('\n');
    assert.match(sees, /Support Agent's ticket subjects and your Accounts Receivable assistant's overdue invoice counts/);
    assert.doesNotMatch(sees, /Support Agent's ticket subjects and overdue invoice counts/);
});

// ── 11, 12. One voice; deals as the review says them ─────────────────────────────────────────────
test('the Overview speaks in the first person throughout', () => {
    const ui = read('src/components/assistant-mentor-overview.js');
    for (const third of ['raises in chat', 'works from this list', 'makes at most', '’s suggestions you haven’t answered', 'Who ${esc(state.assistantName)} would hire', 'will say what works', 'lets it.']) {
        assert.ok(!ui.includes(third), `third person left: ${third}`);
    }
    for (const first of ['The same gaps I raise in chat', 'I work from this list', 'I make at most', 'My suggestions you haven’t answered yet', 'Who I would hire next', 'I’ll say what works', 'Ask me in chat']) {
        assert.ok(ui.includes(first), `missing: ${first}`);
    }
});

test('the Customers panel always says disqualified, as the review does', () => {
    assert.match(read('src/components/assistant-mentor-overview.js'), /lost, <strong>\$\{d\.disqualified \|\| 0\}<\/strong> disqualified\./);
});

console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exitCode = 1;
