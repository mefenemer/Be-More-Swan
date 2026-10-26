// tests/mentor-phase-3.test.ts
// Business Mentor Phase 3 (docs/business-mentor-plan.md §5): the weekly review, commitments, track record
// and customers.
//
//   - The review is due on its day (or later that week), never twice a week, never in Quiet mode or off.
//   - Below the minimum sample it says "not enough data yet" in code, with no model call and no charge.
//   - Commitments: 1–3 a week, a closed list of miss reasons ("other" needs a note), only the owner or an
//     owner/admin closes one; repeated reasons become advice.
//   - Track record says "since", never "because", and is honest about too early / too small.
//   - Customers: only from ACTIVE assistants, never contact details; Be More Swan's own `invoices` is never read.
//   - Every capability has a screen AND a card through one server action (mentor.ts / generate-post.ts);
//     listeners added in mount() are removed in destroy(); the schedule is wired on prod and staging.
//
// Run:  npx tsx tests/mentor-phase-3.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
    hasEnoughData, isReviewDue, notEnoughDataReview, renderFigures, renderReviewSettingsForMentor, reviewMessage, reviewSettings, ukWeekdayIndex,
    type AssistantFigures,
} from '../src/utils/mentor-review';
import {
    canClose, cleanCommitmentTexts, isMissReason, MAX_PER_WEEK, missReasonAdvice, renderCommitmentsForMentor, weekStartUk, weeksBefore, type Commitment,
} from '../src/utils/mentor-commitments';
import { sinceLine, verdictFor, MIN_SAMPLE } from '../src/utils/mentor-outcomes';
import { excerpt, nothingToSee, renderCustomersForMentor, type CustomersView } from '../src/utils/mentor-customers';
import { asksAboutCustomers, type MentorSnapshotData } from '../src/utils/mentor-snapshot';
import { mentorCardFromUiElement, mentorCardsPromptBlock, onlyGapFields } from '../src/utils/mentor-cards';
import { MENTOR_DATA_INVENTORY, mentorVisibility } from '../src/config/mentor-data-inventory';
import { ROLE_MODEL_PATHS, promptLayersFor } from '../src/config/assistant-prompt-layers';
import { TASK_WEIGHTS } from '../src/config/task-weights';
import { categoryForType } from '../src/utils/notification-prefs';
import { REVIEWABLE_KINDS } from '../src/utils/mentor-proposals';
import { changeableSetupFields } from '../src/utils/setup-field';

let passed = 0, total = 0;
function test(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}
const root = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

const data = (over: Partial<MentorSnapshotData> = {}): MentorSnapshotData => ({
    business: { description: 'Dog grooming in Leeds', industry: 'Pets', website: 'https://example.test' },
    products: [], productCount: 0, offerKinds: ['services'], introOfferAnswered: true,
    team: [{ id: 2, name: 'Sam', role: 'Social Media Assistant', state: 'active' }],
    goals: [], plan: { status: 'active', freeSlots: 1 }, ...over,
});
const fig = (over: Partial<AssistantFigures> = {}): AssistantFigures => ({ id: 2, name: 'Sam', role: 'Social Media Assistant', thisWeek: 1, lastWeek: 1, enough: false, breakdown: '', ...over });
const commitment = (over: Partial<Commitment> = {}): Commitment => ({
    id: 1, ownerUserId: 7, ownerName: 'Pat', weekStart: '2026-10-19', text: 'Call three customers', status: 'open',
    missReason: null, note: null, createdAt: null, closedAt: null, ...over,
});

console.log('mentor phase 3 — weekly review');

// Monday 26 Oct 2026 09:00 UK (GMT after the clocks went back on 25 Oct).
const MON = new Date('2026-10-26T09:00:00Z');
const WED = new Date('2026-10-28T09:00:00Z');

test('weeks start on Monday, UK time', () => {
    assert.strictEqual(weekStartUk(MON), '2026-10-26');
    assert.strictEqual(weekStartUk(WED), '2026-10-26');
    assert.strictEqual(weekStartUk(new Date('2026-11-01T23:30:00Z')), '2026-10-26'); // Sunday night
    assert.strictEqual(weeksBefore('2026-10-26', 1), '2026-10-19');
    assert.strictEqual(ukWeekdayIndex(MON), 0);
    assert.strictEqual(ukWeekdayIndex(WED), 2);
});

test('settings: on and Monday by default; off, quiet and a day are read from the set-up answers', () => {
    assert.deepStrictEqual(reviewSettings(null), { on: true, quiet: false, day: 'monday' });
    assert.deepStrictEqual(reviewSettings({ weeklyReview: 'off', quietMode: 'on', reviewDay: 'Friday' }), { on: false, quiet: true, day: 'friday' });
    assert.strictEqual(reviewSettings({ reviewDay: 'someday' }).day, 'monday');
});

test('due on the day or later that week, once a week, never in Quiet mode or switched off', () => {
    const s = reviewSettings({});
    assert.strictEqual(isReviewDue(s, null, MON), true);
    assert.strictEqual(isReviewDue(s, '2026-10-26', WED), false, 'already reviewed this week');
    assert.strictEqual(isReviewDue(s, '2026-10-19', WED), true, 'a missed Monday is caught up');
    assert.strictEqual(isReviewDue(reviewSettings({ reviewDay: 'Wednesday' }), null, MON), false, 'not yet');
    assert.strictEqual(isReviewDue(reviewSettings({ quietMode: 'on' }), null, MON), false);
    assert.strictEqual(isReviewDue(reviewSettings({ weeklyReview: 'off' }), null, MON), false);
});

test('not enough data: thin figures, no measured goal, nothing else → the honest review, written in code', () => {
    const thin = { data: data(), figures: [fig()], commitments: [], record: [], customers: null };
    assert.strictEqual(hasEnoughData(thin, MON), false);
    const r = notEnoughDataReview(thin, MON);
    assert.match(r.summary, /Not enough data yet/);
    assert.match(r.sections[0].text, /won’t invent a trend/);
    assert.match(r.sections[1].text, /one thing/);
    assert.strictEqual(hasEnoughData({ ...thin, figures: [fig({ thisWeek: 4, lastWeek: 3, enough: true })] }, MON), true);
    assert.strictEqual(hasEnoughData({ ...thin, data: data({ goals: [{ assistant: 'Sam', label: 'Followers', latest: 120, target: 500, targetDate: new Date('2026-12-31'), status: 'on_track' }] }) }, MON), true);
    assert.strictEqual(hasEnoughData({ ...thin, commitments: [commitment({ weekStart: '2026-10-19' })] }, MON), true, "last week's commitments are worth reviewing");
});

test('the only assistant: no team figures, and the review says what it reviews instead (§3.12)', () => {
    const lines = renderFigures([], data({ team: [] })).join('\n');
    assert.match(lines, /No active assistant/);
    assert.match(notEnoughDataReview({ data: data({ team: [] }), figures: [], commitments: null, customers: null }, MON).sections[0].text, /no assistant is active/);
});

test('figures say "not enough data" below the sample; never a trend', () => {
    const lines = renderFigures([fig(), fig({ id: 3, name: 'Mira', thisWeek: 6, lastWeek: 2, enough: true })], data()).join('\n');
    assert.match(lines, /Sam.*not enough data to call a trend/);
    assert.doesNotMatch(lines, /Mira.*not enough data/);
});

test('the review message points at Needs you only when there are suggestions', () => {
    assert.match(reviewMessage('A quiet week.', [{ title: 'What went well', text: 'x' }], 2), /2 suggestions follow.*Needs you/s);
    assert.doesNotMatch(reviewMessage('A quiet week.', [], 0), /suggestion/);
});

test('its own settings are in its prompt, changeable through the set-up card', () => {
    const t = renderReviewSettingsForMentor(50, { reviewDay: 'Friday' });
    assert.match(t, /on, every Friday/);
    assert.match(t, /assistantId 50/);
    const keys = changeableSetupFields('business_mentor').map((f) => f.key);
    assert.ok(keys.includes('weeklyReview') && keys.includes('reviewDay'), 'the generic set-up card can change both');
});

test('a volunteered Business Information card fills gaps only — never overwrites (staging, 26 Oct)', () => {
    const current = { description: 'We produce niche movies based on true stories', industry: 'Media', website: 'https://x.test', targetAudience: null };
    assert.strictEqual(onlyGapFields({ businessDescription: 'A niche movie company.', industry: 'Film' }, current), null);
    assert.deepStrictEqual(onlyGapFields({ businessDescription: 'x', targetAudience: 'Adults' }, current), { targetAudience: 'Adults' });
    assert.match(read('src/utils/mentor-review.ts'), /onlyGapFields\(m\.fields, data\.business\)/);
    assert.match(read('netlify/functions/chat-orchestrator.ts'), /!m\.asked && mentorParts && !onlyGapFields/);
});

console.log('mentor phase 3 — commitments');

test('1 to 3 things, trimmed and de-duplicated', () => {
    assert.deepStrictEqual(cleanCommitmentTexts([' Call  three customers ', 'call three customers', 'Post twice']), { ok: true, texts: ['Call three customers', 'Post twice'] });
    assert.strictEqual(cleanCommitmentTexts([]).ok, false);
    assert.strictEqual(cleanCommitmentTexts(['a', 'b', 'c', 'd']).ok, false);
    assert.strictEqual(cleanCommitmentTexts(['x'.repeat(201)]).ok, false);
    assert.strictEqual(MAX_PER_WEEK, 3);
});

test('miss reasons are a closed list; only the owner or an owner/admin closes one', () => {
    for (const r of ['no_time', 'didnt_know_how', 'priorities_changed', 'waiting_on_someone', 'decided_against', 'other']) assert.ok(isMissReason(r), r);
    assert.strictEqual(isMissReason('lazy'), false);
    assert.strictEqual(canClose({ ownerUserId: 7 }, 7, 'member'), true);
    assert.strictEqual(canClose({ ownerUserId: 7 }, 8, 'member'), false);
    assert.strictEqual(canClose({ ownerUserId: 7 }, 8, 'admin'), true);
});

test('repeated reasons become advice; the prompt shows this week, last week and what to ask', () => {
    const list = [
        commitment({ id: 1, status: 'missed', missReason: 'no_time' }),
        commitment({ id: 2, status: 'missed', missReason: 'no_time', weekStart: '2026-10-12' }),
        commitment({ id: 3, status: 'open', weekStart: '2026-10-19', text: 'Write the price list' }),
        commitment({ id: 4, status: 'open', weekStart: '2026-10-26', ownerUserId: 8, ownerName: 'Sam' }),
    ];
    assert.match(missReasonAdvice(list)[0], /No time" 2 times — suggest fewer commitments/);
    const p = renderCommitmentsForMentor(list, 7, MON).join('\n');
    assert.match(p, /This week:\n- #4 Sam: "Call three customers" — open/);
    assert.match(p, /Last week's still open: ask how each went/);
    assert.match(renderCommitmentsForMentor(null, 7, MON).join(''), /not switched on/);
});

test('the commitments card: set needs 1–3 texts; close names a commitment', () => {
    const set = mentorCardFromUiElement({ type: 'mentor_commitments', op: 'set', texts: ['Call three customers'] }, 50);
    assert.ok(set && !('error' in set) && set.type === 'mentor_commitments' && set.op === 'set');
    assert.ok('error' in (mentorCardFromUiElement({ type: 'mentor_commitments', op: 'set', texts: [] }, 50) as object));
    const close = mentorCardFromUiElement({ type: 'mentor_commitments', op: 'close', commitmentId: 4 }, 50);
    assert.ok(close && !('error' in close) && close.type === 'mentor_commitments' && close.op === 'close' && close.commitmentId === 4);
    assert.match(mentorCardsPromptBlock(), /"op":"close"/);
});

console.log('mentor phase 3 — track record');

test('since, never because; too early and too small said plainly', () => {
    const accepted = new Date('2026-10-05T09:00:00Z');
    const base = { title: 'Post on Tuesdays too', measureLabel: 'Work done by Sam in a week', acceptedAt: accepted, checkedAt: MON };
    assert.strictEqual(verdictFor({ ...base, measureKey: 'work7:2', before: 4, after: 9 }, MON), 'up');
    assert.strictEqual(verdictFor({ ...base, measureKey: 'work7:2', before: 1, after: 2 }, MON), 'too_small');
    assert.strictEqual(verdictFor({ ...base, measureKey: 'work7:2', before: 4, after: 9, acceptedAt: new Date('2026-10-24T09:00:00Z') }, MON), 'too_early');
    assert.strictEqual(verdictFor({ ...base, measureKey: null, before: null, after: null }, MON), 'no_measure');
    assert.strictEqual(verdictFor({ ...base, measureKey: null, before: null, after: null, jobId: 'abc' }, MON), 'drafted');
    const up = sinceLine({ ...base, before: 4, after: 9 }, 'up', MON);
    assert.match(up, /4 then, 9 now — up 5 \(\+125%\) since/);
    assert.doesNotMatch(up, /because/i);
    assert.match(sinceLine({ ...base, before: 1, after: 2 }, 'too_small', MON), /too little activity to judge/);
    assert.match(sinceLine({ ...base, before: null, after: null }, 'too_early', MON), /Too early to tell/);
    assert.ok(MIN_SAMPLE >= 5);
});

console.log('mentor phase 3 — customers');

const emptyView: CustomersView = { sources: [{ key: 'deals', label: 'Won and lost deals', available: false, note: 'x' }], deals: null, quiet: null, reviews: null, tickets: null, overdueInvoices: null };

test('nothing to read → it asks about their customers instead; missing is not zero', () => {
    assert.ok(nothingToSee(emptyView));
    assert.match(renderCustomersForMentor(emptyView).join('\n'), /Ask them about their customers/);
    const v: CustomersView = { ...emptyView, deals: { won: 2, lost: 1, disqualified: 0, lossReasons: [], enough: false }, quiet: [{ company: 'Acme Ltd', contact: 'Jo', wonAt: '2026-06-01T00:00:00Z', lastContactAt: null }] };
    const p = renderCustomersForMentor(v).join('\n');
    assert.match(p, /Too few closed deals/);
    assert.match(p, /Acme Ltd \(Jo\), last contact none recorded/);
    assert.match(p, /Not available \(missing ≠ zero\): won and lost deals/);
});

test('review excerpts are cut at a word and never carry the author', () => {
    assert.strictEqual(excerpt('Short and sweet'), 'Short and sweet');
    assert.ok(excerpt('word '.repeat(80)).endsWith('…'));
    const src = read('src/utils/mentor-customers.ts');
    assert.doesNotMatch(src, /authorName|contactEmail|replyToken|leadMessages/, 'no author, address or message body is selected');
});

test('customers only from ACTIVE assistants; Be More Swan\'s own invoices are never read', () => {
    const src = read('src/utils/mentor-customers.ts');
    assert.match(src, /teamState\(t\.life, t\.prov\) === 'active'/);
    assert.doesNotMatch(src, /\binvoices\b.*from '..\/..\/db\/schema'/);
    assert.doesNotMatch(src, /from '\.\/churn/, 'the business\'s customers, not Be More Swan\'s churn');
    assert.strictEqual(MENTOR_DATA_INVENTORY.invoices.access, 'never');
    assert.strictEqual(MENTOR_DATA_INVENTORY.audience_contacts.access, 'never');
    assert.strictEqual(MENTOR_DATA_INVENTORY.lead_messages.access, 'never');
});

test('customers are read on request in chat (when asked), and listed under "What I can see"', () => {
    assert.ok(asksAboutCustomers('which customers have gone quiet?'));
    assert.ok(!asksAboutCustomers('write me a post'));
    for (const t of ['revenue_events', 'discovered_leads', 'lead_threads', 'org_reviews', 'assistant_records']) assert.strictEqual(MENTOR_DATA_INVENTORY[t].access, 'on_request', t);
    for (const t of ['mentor_reviews', 'mentor_commitments', 'mentor_outcomes']) assert.strictEqual(MENTOR_DATA_INVENTORY[t].access, 'always', t);
    assert.ok(mentorVisibility().sees.some((s) => /Your customers/.test(s)));
    assert.match(read('netlify/functions/chat-orchestrator.ts'), /withCustomers: asksAboutCustomers\(typed\)/);
});

console.log('mentor phase 3 — wiring');

test('one server action per capability, screen and card', () => {
    const fn = read('netlify/functions/mentor.ts');
    for (const a of ["'review_now'", "'commitments_add'", "'commitment_close'", '?reviews=1', '?customers=1', '?commitments=1']) assert.ok(fn.includes(a), a);
    assert.match(fn, /decision === 'accepted'\) await recordOutcome/);
    const apply = read('src/components/mentor-apply.js');
    assert.match(apply, /action: 'commitments_add'/);
    assert.match(apply, /action: 'commitment_close'/);
    assert.match(apply, /generate-post', \{ assistantId: Number\(assistantId\), contextPrompt/);
    // Both the screen and the card go through MentorApply.
    assert.match(read('src/components/mentor-commitments.js'), /A\.commitmentsAdd\(/);
    assert.match(read('src/components/mentor-commitments.js'), /A\.commitmentClose\(/);
    assert.match(read('src/components/chat-session.js'), /A\.commitmentsAdd\(d\.texts\)/);
    assert.match(read('src/components/assistant-mentor-overview.js'), /MentorApply\.reviewNow\(\)/);
    assert.ok((REVIEWABLE_KINDS as readonly string[]).includes('draft_request'), 'post requests wait in Needs you too');
});

test('card listeners added in mount() are removed in destroy()', () => {
    const src = read('src/components/chat-session.js');
    for (const ev of ['mentor:commitmentsAdd', 'mentor:commitmentClose', 'mentor:draftRequest']) {
        assert.ok(src.includes(`container.addEventListener('${ev}'`), `add ${ev}`);
        assert.ok(src.includes(`container.removeEventListener('${ev}'`), `remove ${ev}`);
    }
});

test('a suggestion answered elsewhere shows as answered (chat-card-refresh.ts)', () => {
    assert.match(read('src/utils/chat-card-refresh.ts'), /refreshMentorCards\(db, organisationId, out\)/);
    assert.match(read('src/components/disruptive-ui-registry.js'), /suggestion && answered && MENTOR_ANSWERED\[answered\]/);
});

test('a Mentor post request carries "Requested by" the Mentor', () => {
    assert.match(read('netlify/functions/generate-post.ts'), /linkOutcomeJob\(db, organisationId, body\.mentorProposalId, jobId\)/);
    assert.match(read('src/utils/requested-by.ts'), /mentorRequesterNames\(db, organisationId, ids\)/);
});

test('metered at 1 task, registered with its model, and its prompt shown on Model & rules', () => {
    assert.strictEqual(TASK_WEIGHTS.mentor_review, 1);
    assert.ok(ROLE_MODEL_PATHS.business_mentor.some((p) => p.label === 'Weekly review' && p.defaultModel === 'claude-opus-5-5'));
    const keys = promptLayersFor('business_mentor').map((l) => l.key);
    assert.ok(keys.includes('mentor_review') && keys.includes('workspace_mentor_review'));
});

test('delivery follows each user\'s settings: its own notification row, in-app and email', () => {
    const cat = categoryForType('mentor_weekly_review');
    assert.strictEqual(cat.key, 'mentor_weekly_review');
    assert.strictEqual(cat.inApp.locked, false);
    assert.strictEqual(cat.email.locked, false);
    const src = read('src/utils/mentor-review.ts');
    assert.match(src, /isEmailEnabled\(p\.emailPrefs, 'mentor_weekly_review'\)/);
    assert.match(src, /REVIEW_ROLES = \['owner', 'admin'\]/);
    assert.match(read('src/utils/email-templates-catalog.ts'), /triggerKey: 'mentor_weekly_review'/);
    assert.match(read('src/utils/notification-templates-catalog.ts'), /templateKey: 'mentor_weekly_review'/);
});

test('the review is scheduled on prod and poked on staging', () => {
    assert.match(read('netlify.toml'), /\[functions\.dispatch-mentor-reviews\]\n  schedule = "45 6 \* \* \*"/);
    assert.match(read('.github/workflows/staging-crons.yml'), /^\s+run-mentor-review-dispatch\s+21600\s+120$/m);
});

test('the review reaches the reader: "Open in chat" and the notification open its conversation; commitments come as a card', () => {
    const src = read('src/utils/mentor-review.ts');
    assert.match(src, /chatSessionId: sessions\.get\(p\.userId\) \?\? null/);
    assert.match(src, /commitmentCard = \{ type: 'mentor_commitments', op: 'set'/);
    assert.match(read('notifications.js'), /notif\.type === 'mentor_weekly_review'[\s\S]{0,300}openAssistantChat\(\{ assistantId: meta\.assistantId, sessionId: meta\.chatSessionId \}\)/);
    assert.match(read('src/components/assistant-mentor-overview.js'), /data-mentor-open-review/);
});

test('the SQL is idempotent and drops nothing', () => {
    const sql = read('db/z-business-mentor-phase-3.sql');
    assert.doesNotMatch(sql, /\bDROP\b/i);
    for (const t of ['mentor_reviews', 'mentor_commitments', 'mentor_outcomes']) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${t}`));
});

test('the prompt names the real screens (§14)', () => {
    const o = read('netlify/functions/chat-orchestrator.ts');
    const page = read('src/components/assistant-mentor-overview.js') + read('src/components/mentor-commitments.js');
    for (const name of ['Reviews', 'Customers', 'Track record', 'Commitments', 'Review my week now', 'Add one for this week', 'Earlier weeks', 'Missed…']) {
        assert.ok(o.includes(`"${name}`), `prompt names ${name}`);
        assert.ok(page.includes(name), `page has ${name}`);
    }
});

console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exitCode = 1;
