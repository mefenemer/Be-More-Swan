// tests/mentor-phase-2.test.ts
// Business Mentor Phase 2 (docs/business-mentor-plan.md §4): idea check, strategy documents, break-even,
// research with sources and playbooks.
//
//   - Break-even is worked out in code and matches a hand calculation; guesses are labelled.
//   - Documents: only known sections are saved; one draft and one approved; the diff is word-level.
//   - The pre-draft is filled only from what the workspace already holds (nothing invented).
//   - Only APPROVED text reaches drafting, through business-knowledge.ts (the one loader) and blueprint §11.
//   - Research keeps only URLs the search returned; no search / no source = it says so.
//   - A playbook is never used until a person has reviewed it.
//   - Every capability has a screen AND a card through one server action (mentor.ts), and the prompt names
//     the Plan tab's real labels.
//
// Run:  npx tsx tests/mentor-phase-2.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { breakEven } from '../src/utils/break-even';
import {
    STRATEGY_KINDS, cleanStrategyPatch, diffStrategy, diffWords, mergeBody, pickVersions, prefillStrategy,
    renderApprovedStrategyForDrafts, renderStrategyForMentor, sectionsWithOpenQuestions, type StrategyDoc,
} from '../src/utils/strategy-documents';
import { businessKnowledgePromptBlock } from '../src/utils/business-knowledge';
import { parseResearchReply, shortQuestion } from '../src/utils/mentor-jobs';
import { buildBreakEvenCard, buildStrategyCard, cleanQuestion } from '../src/utils/mentor-plan-cards';
import { cardTheUserAskedFor, mentorCardFromUiElement, proposalKind } from '../src/utils/mentor-cards';
import { PLAYBOOKS, isUsablePlaybook, playbookFor, renderPlaybookForMentor, type Playbook } from '../src/config/mentor-playbooks';
import { ROLE_MODEL_PATHS, promptLayersFor } from '../src/config/assistant-prompt-layers';
import { TASK_WEIGHTS } from '../src/config/task-weights';

let passed = 0, total = 0;
function test(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}
const root = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

const doc = (over: Partial<StrategyDoc>): StrategyDoc => ({
    id: 1, kind: 'business_plan', version: 1, status: 'draft', body: { sections: {} }, approvedAt: null, approvedBy: null, updatedAt: new Date('2026-10-25T10:00:00Z'), ...over,
});

console.log('Business Mentor Phase 2: plans, break-even, research, playbooks');

test('break-even matches a hand calculation, and a guess is labelled', () => {
    // £40 price − £15 cost = £25 a sale. £500 ads + £1,000 fixed = £1,500 → 60 sales. At 5%: 1,200 leads.
    const r = breakEven({ price: 40, costPerSale: 15, fixedCosts: 1000, spend: 500, conversionRate: { value: 5, source: 'assumption', note: 'my guess' } });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.strictEqual(r.marginPerSale, 25);
    assert.strictEqual(r.salesToCoverSpend, 20);
    assert.strictEqual(r.salesToBreakEven, 60);
    assert.strictEqual(r.leadsToBreakEven, 1200);
    assert.strictEqual(r.leadsToCoverSpend, 400);
    assert.deepStrictEqual(r.assumed, ['leads that become a sale']);
    assert.match(r.sentence, /^Worked out in code: .*60 sales.*1,200 leads.*Assumed, not from you/);
    // Rounds UP: £100 / £30 = 3.33 → 4 sales.
    const up = breakEven({ price: '£50', costPerSale: 20, spend: '£100' });
    assert.ok(up.ok && up.salesToBreakEven === 4 && up.leadsToBreakEven === null);
});

test('break-even refuses inputs that cannot break even, instead of guessing', () => {
    assert.ok(!breakEven({ costPerSale: 5, spend: 100 }).ok, 'no price');
    const neg = breakEven({ price: 10, costPerSale: 12, spend: 100 });
    assert.ok(!neg.ok && /no number of sales/.test(neg.error));
    assert.ok(!breakEven({ price: 10 }).ok, 'nothing to cover');
    const zeroGuess = breakEven({ price: 12, costPerSale: 2, spend: 500, fixedCosts: { value: 0, source: 'assumption' } });
    assert.ok(zeroGuess.ok && !zeroGuess.assumed.length && !/Assumed/.test(zeroGuess.sentence), 'a £0 guess is not reported as an assumption');
    const badRate = breakEven({ price: 10, spend: 100, conversionRate: 140 });
    assert.ok(badRate.ok && badRate.leadsToBreakEven === null, 'an impossible rate is dropped, not used');
    const card = buildBreakEvenCard('x', { price: 40, costPerSale: 15, spend: 500 });
    assert.ok(!('error' in card) && card.result.salesToBreakEven === 20 && card.sentence.startsWith('Worked out in code'));
});

test('a save keeps only the kind’s own sections, within their limits; empty clears', () => {
    const p = cleanStrategyPatch('business_plan', { sections: { offer: '  Grooming  ', secrets: 'x', customer: '' } });
    assert.deepStrictEqual(p, { sections: { offer: 'Grooming', customer: '' } });
    assert.strictEqual(cleanStrategyPatch('business_plan', { sections: { nope: 'x' } }), null);
    const long = cleanStrategyPatch('marketing_plan', { sections: { goals: 'x'.repeat(5000) } });
    assert.strictEqual(long!.sections.goals.length, 1000);
    // Assumptions only on the idea check, at most 6, each needing an assumption.
    const a = cleanStrategyPatch('idea_check', { assumptions: [...Array(9)].map((_, i) => ({ assumption: i ? `A${i}` : '', test: 'T' })) });
    assert.strictEqual(a!.assumptions!.length, 5);
    assert.strictEqual(cleanStrategyPatch('business_plan', { assumptions: [{ assumption: 'x' }] }), null);
    const merged = mergeBody({ sections: { offer: 'old', customer: 'keep' } }, { sections: { offer: 'new', pricing: '' } });
    assert.deepStrictEqual(merged.sections, { offer: 'new', customer: 'keep' });
});

test('the idea check is the eight interview questions plus the nine Lean Canvas boxes', () => {
    const s = STRATEGY_KINDS.idea_check.sections;
    assert.strictEqual(s.filter((x) => x.group === 'interview').length, 8);
    assert.deepStrictEqual(s.filter((x) => x.group === 'canvas').map((x) => x.label), [
        'Problem', 'Customer segments', 'Unique value proposition', 'Solution', 'Channels', 'Revenue streams', 'Cost structure', 'Key metrics', 'Unfair advantage',
    ]);
});

test('versions: one draft and one approved per kind; the diff is word-level and per section', () => {
    const docs = [doc({ id: 3, version: 3, status: 'draft' }), doc({ id: 2, version: 2, status: 'approved' }), doc({ id: 1, version: 1, status: 'superseded' })];
    const v = pickVersions(docs, 'business_plan');
    assert.ok(v.draft!.id === 3 && v.approved!.id === 2 && v.earlier.length === 1);
    const parts = diffWords('Dog grooming in Leeds', 'Cat grooming in Leeds');
    assert.deepStrictEqual(parts.filter((p) => p.op !== 'same').map((p) => `${p.op}:${p.text}`), ['del:Dog', 'add:Cat']);
    const d = diffStrategy('business_plan', { sections: { offer: 'A', customer: 'same' } }, { sections: { offer: 'B', customer: 'same', pricing: 'new' } });
    assert.deepStrictEqual(d.map((x) => `${x.key}:${x.change}`), ['offer:changed', 'pricing:added']);
    // The SQL enforces it too.
    const sql = read('db/z-business-mentor-phase-2.sql');
    assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS strategy_documents_one_draft_idx[\s\S]*WHERE status = 'draft'/);
    assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS strategy_documents_one_approved_idx[\s\S]*WHERE status = 'approved'/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS mentor_jobs/);
});

test('the pre-draft (§13.2) is filled only from what the workspace holds', () => {
    const src = {
        description: 'Mobile dog grooming in Leeds.', audience: 'Busy dog owners in north Leeds', industry: 'Pets',
        products: [{ name: 'Full groom', kind: 'service', price: '£45' }, { name: 'Nail trim', kind: 'service', price: null }],
        offerKinds: ['services', 'bookings'], activeTeam: [{ name: 'Sam', role: 'Social Media Assistant' }],
        goals: [{ assistant: 'Sam', label: 'Followers', target: 500, targetDate: new Date('2026-12-31') }],
    };
    const bp = prefillStrategy('business_plan', src)!;
    assert.strictEqual(bp.sections.customer, 'Busy dog owners in north Leeds');
    assert.match(bp.sections.offer, /Mobile dog grooming[\s\S]*Full groom \(£45\); Nail trim/);
    assert.ok(!bp.sections.milestones && !bp.sections.numbers && !bp.sections.problem, 'never invents milestones, numbers or a problem');
    const mp = prefillStrategy('marketing_plan', src)!;
    assert.match(mp.sections.goals, /Followers — 500 by 2026-12-31/);
    assert.ok(!mp.sections.messaging && !mp.sections.cadence);
    assert.strictEqual(prefillStrategy('business_plan', { ...src, description: null, audience: null, products: [], offerKinds: null, activeTeam: [], goals: [] }), null);
});

test('only APPROVED text, and only the sections that feed drafts, reach every assistant', () => {
    const docs = [
        doc({ status: 'approved', body: { sections: { customer: 'Dog owners', offer: 'Grooming at home', numbers: '£2k a month', milestones: 'Q1' } } }),
        doc({ id: 9, kind: 'marketing_plan', status: 'draft', body: { sections: { messaging: 'DRAFT ONLY' } } }),
    ];
    const text = renderApprovedStrategyForDrafts(docs)!;
    assert.match(text, /Who the customer is: Dog owners/);
    assert.match(text, /The offer: Grooming at home/);
    assert.ok(!/£2k|Q1|DRAFT ONLY/.test(text), 'numbers, milestones and drafts stay out');
    assert.strictEqual(renderApprovedStrategyForDrafts([docs[1]]), null);
    // A [question] left by the Mentor blocks approval and never reaches a prompt (staging, 2026-10-26: an
    // approved draft carried "[Which niche subjects do you focus on?]" into every assistant's brief).
    const q = { sections: { audience: 'Film fans\n[Which niche subjects do you focus on?]', messaging: 'True stories' } };
    assert.deepStrictEqual(sectionsWithOpenQuestions('marketing_plan', q), ['Audience']);
    const shown = renderApprovedStrategyForDrafts([doc({ kind: 'marketing_plan', status: 'approved', body: q })])!;
    assert.ok(shown.includes('Audience: Film fans') && !shown.includes('['), shown);
    assert.ok('error' in buildStrategyCard({ op: 'approve', kind: 'marketing_plan', summary: 's', why: null, asked: true }, [doc({ kind: 'marketing_plan', body: q })]));
    assert.match(read('src/utils/strategy-documents.ts'), /const open = sectionsWithOpenQuestions\(kind, draft\.body\);\s*if \(open\.length\) return \{ ok: false as const, status: 400/);
    // The one renderer: chat, blog-generate and blueprint §11 all go through businessKnowledgePromptBlock.
    const block = businessKnowledgePromptBlock({ documents: [], links: [], strategy: text })!;
    assert.match(block, /^APPROVED STRATEGY — The business owner approved this strategy[\s\S]*Dog owners/);
    assert.match(businessKnowledgePromptBlock({ documents: [{ name: 'Guide', text: 'Be kind' }], links: [], strategy: text })!, /BUSINESS KNOWLEDGE[\s\S]*Be kind[\s\S]*APPROVED STRATEGY/);
    const bk = read('src/utils/business-knowledge.ts');
    assert.match(bk, /loadStrategyDocs\(db, organisationId\)/);
    const bp = read('src/utils/blueprint.ts');
    assert.match(bp, /hashParts\.push\(\{ id: `strategy:\$\{d\.id\}`, updatedAt: d\.approvedAt \}\)/, 'approving forces a recompile');
    assert.match(read('netlify/functions/mentor.ts'), /approveStrategyDraft[\s\S]{0,400}recompileOrgBlueprints\(db, orgId/);
});

test('the Mentor sees its own documents, says when the table is missing, and only drafts are "waiting"', () => {
    const lines = renderStrategyForMentor([doc({ status: 'approved', version: 2, body: { sections: { offer: 'X' } } }), doc({ id: 2, version: 3 })]).join('\n');
    assert.match(lines, /Business plan: approved v2; a draft v3 is waiting for approval/);
    assert.match(lines, /Idea check: not started/);
    assert.match(renderStrategyForMentor(null).join('\n'), /Not available in this workspace yet/);
});

test('research keeps only links the search returned; no search or no source means "I won’t guess"', () => {
    const searched = ['https://www.gov.uk/vat-registration', 'https://www.ons.gov.uk/x'];
    const ok = parseResearchReply(JSON.stringify({ answer: 'The VAT threshold is £90,000. See https://made-up.example/vat', sources: [
        { url: 'https://www.gov.uk/vat-registration/', title: 'VAT registration' }, { url: 'https://invented.example/a', title: 'Fake' },
    ] }), searched, 2);
    assert.strictEqual(ok.outcome, 'answered');
    assert.deepStrictEqual(ok.sources.map((s) => s.url), ['https://www.gov.uk/vat-registration']);
    assert.ok(ok.answer.includes('[link removed]') && !ok.answer.includes('made-up.example'));
    const none = parseResearchReply(JSON.stringify({ answer: 'From memory: 42%', sources: [{ url: 'https://invented.example' }] }), searched, 3);
    assert.ok(none.outcome === 'nothing_found' && !/42%/.test(none.answer) && !none.sources.length);
    const noSearch = parseResearchReply(JSON.stringify({ answer: 'x', sources: [{ url: searched[0] }] }), searched, 0);
    assert.ok(noSearch.outcome === 'no_search' && /Nothing was charged/.test(noSearch.answer));
    const sq = shortQuestion('What do UK viewers typically pay to rent a new independent or documentary-style feature film online (transactional video on demand)?');
    assert.ok(sq.endsWith('online…') && sq.length <= 111, sq);
    assert.ok(cleanQuestion('hi').ok === false && cleanQuestion('What do groomers in Leeds charge?').ok);
});

test('research and drafting are background jobs, metered at 1 task on delivery, on the Mentor’s model', () => {
    assert.strictEqual(TASK_WEIGHTS.mentor_research, 1);
    assert.strictEqual(TASK_WEIGHTS.mentor_strategy, 1);
    const jobs = read('src/utils/mentor-jobs.ts');
    assert.match(jobs, /if \(charge\) await recordCompletedWork\(db, job\.organisationId, 'mentor_research'/);
    assert.match(jobs, /if \(charge\) await recordCompletedWork\(db, job\.organisationId, 'mentor_strategy'/);
    assert.match(jobs, /withRoleModel\(\s*await loadRoleModel\(db, MENTOR_ROLE_KEY\), MENTOR_JOB_DEFAULT_MODEL,\s*\(m, thinking\) => gatewayGenerateGrounded/);
    assert.match(jobs, /adaptForModel\(\{/);
    assert.match(jobs, /replyText\(response\.content\)/);
    assert.match(jobs, /fetch\(`\$\{baseUrl\}\/\.netlify\/functions\/mentor-job-background`/);
    assert.match(read('netlify/functions/mentor-job-background.ts'), /CRON_TRIGGER_SECRET[\s\S]*runMentorJob\(getDb\(\), jobId\)/);
    assert.deepStrictEqual(ROLE_MODEL_PATHS.business_mentor.map((p) => [p.label, p.defaultModel]), [
        ['Strategy documents', 'claude-opus-5-5'], ['Research with sources', 'claude-opus-5-5'], ['Weekly review', 'claude-opus-5-5'],
    ]);
    const layers = promptLayersFor('business_mentor').map((l) => l.usedBy);
    assert.ok(layers.includes('Strategy documents') && layers.includes('Research with sources'));
    // A grounded call honours the role's model (it used to ignore it).
    assert.match(read('src/lib/ai-gateway.ts'), /const roleModel = req\.model && modelOption\(req\.model\) \? req\.model : null;/);
});

test('a playbook is never used until a person has reviewed it', () => {
    const base: Playbook = { kind: 'services', title: 'T', dated: '2026-10-25', reviewed: null,
        whatGoodLooksLike: [{ text: 'x', sources: [{ title: 's', url: 'https://example.gov.uk' }] }], first90Days: [], commonMistakes: [], measures: [] };
    assert.strictEqual(isUsablePlaybook(base), false);
    assert.strictEqual(playbookFor(['services'], [base]).inUse, null);
    assert.deepStrictEqual(playbookFor(['services'], [base]).awaitingReview, ['services']);
    assert.match(renderPlaybookForMentor(playbookFor(['services'], [base])).join(''), /none reviewed/);
    const reviewed = { ...base, reviewed: { by: 'Owner', on: '2026-10-26' } };
    assert.strictEqual(playbookFor(['menu', 'services'], [reviewed]).inUse, reviewed);
    // An unsourced point must be marked as the reviewer's judgement.
    assert.strictEqual(isUsablePlaybook({ ...reviewed, measures: [{ text: 'y', sources: [] }] }), false);
    // Every shipped draft is unreviewed, so nothing reaches a prompt until the owner signs it off.
    for (const p of PLAYBOOKS) assert.strictEqual(p.reviewed, null, `${p.kind} playbook must stay unreviewed until the owner reviews it`);
});

test('chat cards: rebuilt from the real documents; approve needs a draft; volunteered revisions are suggestions', () => {
    const docs = [doc({ status: 'approved', body: { sections: { offer: 'Old offer' } } })];
    const rev = buildStrategyCard({ op: 'revise', kind: 'business_plan', summary: 's', why: 'w', asked: true, sections: { offer: 'New offer', bogus: 'x' } }, docs);
    assert.ok(!('error' in rev) && rev.changes!.length === 1 && rev.changes![0].now === 'Old offer' && rev.changes![0].next === 'New offer');
    assert.ok('error' in buildStrategyCard({ op: 'revise', kind: 'business_plan', summary: 's', why: 'w', asked: true, sections: { offer: 'Old offer' } }, docs));
    assert.ok('error' in buildStrategyCard({ op: 'approve', kind: 'business_plan', summary: 's', why: null, asked: true }, docs), 'nothing to approve');
    const ap = buildStrategyCard({ op: 'approve', kind: 'business_plan', summary: 's', why: null, asked: true }, [...docs, doc({ id: 7, version: 2, body: { sections: { offer: 'New' } } })]);
    assert.ok(!('error' in ap) && ap.draftId === 7 && ap.changed![0].label === 'The offer');
    const m = mentorCardFromUiElement({ type: 'strategy_proposal', op: 'revise', kind: 'marketing_plan', asked: false, why: 'Your audience is empty', sections: { audience: 'x' } }, 50);
    assert.ok(m && !('error' in m) && proposalKind(m) === 'strategy_revision');
    const idea = mentorCardFromUiElement({ type: 'strategy_proposal', op: 'revise', kind: 'idea_check', asked: false, sections: { buyer: 'x' } }, 50);
    assert.ok(idea && !('error' in idea) && proposalKind(idea) === null, 'the user’s own interview answers are never a suggestion');
    assert.ok('error' in (mentorCardFromUiElement({ type: 'strategy_proposal', op: 'revise', kind: 'marketing_plan', asked: false, sections: {} }, 50) as object));
    assert.ok('error' in (mentorCardFromUiElement({ type: 'mentor_research', question: 'x' }, 50) as object));
    // Opus 5.5 said "the approval card is below" and drew none (staging, 2026-10-25): the user's ask draws it.
    const askApprove = cardTheUserAskedFor('My buyer answer is right. Please approve my idea check.');
    assert.ok(askApprove && askApprove.type === 'strategy_proposal' && askApprove.op === 'approve' && askApprove.kind === 'idea_check');
    assert.strictEqual(cardTheUserAskedFor('Don’t approve my business plan yet'), null);
    const askDraft = cardTheUserAskedFor('Can you draft my marketing plan?');
    assert.ok(askDraft && askDraft.type === 'strategy_proposal' && askDraft.op === 'draft' && askDraft.kind === 'marketing_plan');
    const o = read('netlify/functions/chat-orchestrator.ts');
    assert.match(o, /m\.type === 'mentor_break_even'[\s\S]{0,700}content = `\$\{content\}\\n\\n\$\{card\.sentence\}`/, 'the figure is written by code under the reply');
});

test('every Phase 2 capability has a screen AND a card through the same mentor.ts action (§14)', () => {
    const fn = read('netlify/functions/mentor.ts');
    const plan = read('src/components/assistant-mentor-plan.js');
    const apply = read('src/components/mentor-apply.js');
    for (const action of ['strategy_save', 'strategy_approve', 'strategy_draft', 'research', 'break_even']) {
        assert.ok(fn.includes(`body.action === '${action}'`), `mentor.ts handles ${action}`);
        assert.ok(plan.includes(`action: '${action}'`), `the Plan tab calls ${action}`);
        if (action !== 'break_even') assert.ok(apply.includes(`action: '${action}'`), `the chat card calls ${action}`);
    }
    // Break-even's card computes on the server with the same function the screen's action uses.
    assert.match(read('src/utils/mentor-plan-cards.ts'), /const r = breakEven\(/);
    assert.match(fn, /const r = breakEven\(/);
    // Approval is for the roles that manage the workspace, checked on the server.
    assert.match(fn, /if \(!canApproveStrategy\(ctx\.role\)\) return json\(403/);
});

test('the Plan tab is wired, and the prompt names its real labels', () => {
    const html = read('assistant-detail.html');
    assert.match(html, /id="maintab-btn-mentorplan" data-maintab="mentorplan"/);
    assert.match(html, /<div id="maintab-mentorplan" role="tabpanel"[^>]*>\s*<div id="mentor-plan-host"><\/div>/);
    assert.match(read('src/components/assistant-dashboard-registry.js'), /mentorPlanTab: \{\s*\n\s*label: 'Plan',/);
    assert.match(read('workspace.html'), /<script src="\/src\/components\/assistant-mentor-plan\.js"><\/script>/);
    assert.match(read('assistants.js'), /window\.AssistantMentorPlan\?\.init\(/);
    const o = read('netlify/functions/chat-orchestrator.ts');
    const surfaces = o.slice(o.indexOf('function businessMentorSurfaces()'), o.indexOf('function mysteryShopperSurfaces()'));
    const plan = read('src/components/assistant-mentor-plan.js');
    for (const label of ['Your plans', 'Lean Canvas', 'Riskiest assumptions', 'Save draft', 'Approve', 'Earlier versions', 'Draft it for me', 'Draft my canvas', 'Use this draft', 'Look this up', 'Break-even calculator', 'A guess', 'Work it out', 'Back', 'Next']) {
        assert.ok(surfaces.includes(`"${label}"`), `prompt names "${label}"`);
        assert.ok(plan.includes(label), `the Plan tab shows "${label}"`);
    }
    assert.ok(surfaces.includes('"The playbook I\'m using"') && plan.includes('The playbook I’m using'));
    assert.ok(surfaces.includes('"Research"') && plan.includes('>Research<'));
    assert.ok(surfaces.includes('"Changes"') && plan.includes('Changes ('));
});

console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exit(1);
