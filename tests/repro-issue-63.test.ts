// tests/repro-issue-63.test.ts
// Fix pipeline #63 (owner, 2026-11-16): "For Mr Magoo, on the 9th Nov the website score was 90 and on the 16th Nov
// it went down to 80. Why is this? Does Mr Magoo explain? Should it?"
// Prod (org 37, audit 1): runs 25 / 30 / 34 scored 90 / 80 / 90. The owner's page was IDENTICAL in 25 and 30, every
// clarity and AI-search answer was the same, and exactly two competitor questions flipped (clearer_promise,
// feels_safer: pass → fail → pass). A competitor's page had changed, which re-asks every question, and the yes/no
// answers are sampled (today's models take no temperature; the code comment claiming "temperature 0" was wrong).
// Owner, 2026-11-24: "Steady scores". This replays that week through the REAL runAuditCore with a fake model.
import assert from 'node:assert';
import { runAuditCore, flippedIds, steadyAnswers, scoreChangesFrom, type AuditDeps, type AuditInput, type FetchResult } from '../src/utils/site-audit';
import { scoreChangesLine } from '../src/utils/site-audit-prompts';
import { extractSitePage } from '../src/utils/site-extract';
import { rubricFor, type Lens } from '../src/utils/site-score';

const SITE = 'https://bemoreswan.example/';
const RIVAL = 'https://rival.example/';
const body = (extra: string) => `<html><body><h1>Assistants that do the busywork for small businesses</h1>
<p>Be More Swan gives a small business a team of AI assistants that draft social posts, write blogs, chase leads and keep the books tidy, so the owner gets back the hours they lose every week.</p>
<p>Every piece of work waits for your approval before it goes anywhere. Plans start with a free trial and you can cancel any time.</p>
<h2>${extra}</h2><a href="/signup">Start free trial</a></body></html>`;
const rivalPage = (v: string) => `<html><body><h1>The AI employee for agencies</h1><h2>${v}</h2><p>Our assistant writes, schedules and reports so your team can focus on clients, with a thirty day guarantee and one simple monthly plan for every agency size.</p><p>Thousands of agencies already use it to save time on routine work every single week, from client reporting and social scheduling to invoices, onboarding emails and the weekly status update that nobody enjoys writing but every client expects to receive on time.</p><p>Set it up in an afternoon, connect your tools, and let it handle the repetitive parts while your people do the work clients pay for.</p></body></html>`;

function whichLens(system: string): Lens | 'summary' {
    if (system.startsWith('You are the Mystery Shopper')) return 'summary';
    if (system.includes('five seconds')) return 'clarity';
    if (system.includes('competitors in open browser tabs')) return 'compete';
    if (system.includes('simulating how an AI assistant')) return 'ai';
    throw new Error('unrecognised prompt');
}
const reply = (lens: Lens, flip: string[] = []) => JSON.stringify({
    answers: rubricFor(lens).map((q) => ({ id: q.id, yes: flip.includes(q.id) ? !q.goodAnswer : q.goodAnswer, evidence: '' })), fixes: [],
});

/** Each lens answers from its queue in order (then all-good), so a test can script "flipped, then not". */
function fake(html: Record<string, string>, queues: Partial<Record<Lens, string[][]>> = {}) {
    const calls: string[] = [];
    const q = { clarity: [...(queues.clarity ?? [])], compete: [...(queues.compete ?? [])], ai: [...(queues.ai ?? [])] };
    const deps: AuditDeps = {
        async fetchPage(url): Promise<FetchResult> { return html[url] ? { ok: true, page: extractSitePage(html[url], url) } : { ok: false, message: '404' }; },
        async callModel(req) {
            const which = whichLens(req.system);
            calls.push(which);
            if (which === 'summary') return '{}';
            return reply(which, q[which].shift() ?? []);
        },
        async hasCapacity() { return true; },
    };
    return { deps, calls };
}
const brief = { url: SITE, icp: 'Small business owners', conversionGoal: 'Start a free trial', productsBlock: null };

(async () => {
    // 9 Nov: the baseline. Everything passes.
    const nov9 = await runAuditCore({ kind: 'baseline', brief, competitorUrls: [RIVAL], lastHashes: {}, previousPages: {}, previousScore: null },
        fake({ [SITE]: body('Made in Britain.'), [RIVAL]: rivalPage('Version one.') }).deps);
    assert.strictEqual(nov9.status, 'done');
    if (nov9.status !== 'done') return;
    const weekAfter = (over: Partial<AuditInput> = {}): AuditInput => ({
        kind: 'weekly', brief, competitorUrls: [RIVAL], lastHashes: nov9.hashes, previousPages: nov9.pages, previousScore: nov9.score.overall,
        previousAnswers: nov9.answers, previousOutcomes: nov9.score.outcomes, ...over,
    });
    const FLIP = ['clearer_promise', 'feels_safer'];

    // 16 Nov: the owner's page is the same; the competitor's changed; the compete answers come back flipped once.
    const f16 = fake({ [SITE]: body('Made in Britain.'), [RIVAL]: rivalPage('Version two of our story.') }, { compete: [FLIP, []] });
    const nov16 = await runAuditCore(weekAfter(), f16.deps);
    assert.strictEqual(nov16.status, 'done');
    if (nov16.status !== 'done') return;
    assert.strictEqual(nov16.score.overall, nov9.score.overall, `the score holds (was ${nov9.score.overall}, now ${nov16.score.overall})`);
    assert.deepStrictEqual(f16.calls.sort(), ['compete', 'compete', 'summary'], 'unchanged page: clarity and AI search not asked again; the flip asked twice');
    assert.deepStrictEqual(nov16.report.reusedLenses, ['clarity', 'ai']);
    assert.deepStrictEqual(nov16.report.scoreChanges, { ownPageChanged: false, competitorsChanged: true, flipped: [] });
    assert.match(scoreChangesLine(nov16.report.scoreChanges), /Your page didn’t change; a competitor’s did\. No check changed result\./);

    // A real change is seen twice — then it counts, and the owner is told what changed and where.
    const fReal = fake({ [SITE]: body('Made in Britain.'), [RIVAL]: rivalPage('Version two of our story.') }, { compete: [FLIP, FLIP] });
    const real = await runAuditCore(weekAfter(), fReal.deps);
    assert.ok(real.status === 'done' && real.score.overall! < nov9.score.overall!, 'a confirmed change moves the score');
    if (real.status !== 'done') return;
    assert.deepStrictEqual(real.report.scoreChanges?.flipped.map((x) => [x.id, x.now]).sort(), [['clearer_promise', 'fail'], ['feels_safer', 'fail']]);
    assert.match(scoreChangesLine(real.report.scoreChanges), /^Your page didn’t change; a competitor’s did\. Against competitors — now fails:/);

    // The owner's page changed: its lenses are asked again (and a flip there is confirmed the same way).
    const fOwn = fake({ [SITE]: body('Made in Britain, now in Wales too.'), [RIVAL]: rivalPage('Version one.') });
    const own = await runAuditCore(weekAfter(), fOwn.deps);
    assert.ok(own.status === 'done');
    assert.deepStrictEqual(fOwn.calls.filter((c) => c !== 'summary').sort(), ['ai', 'clarity', 'compete'], 'every lens re-read');
    if (own.status === 'done') assert.strictEqual(own.report.scoreChanges?.ownPageChanged, true);

    // The pure pieces.
    const prev = [{ id: 'a', yes: true, evidence: '' }, { id: 'b', yes: true, evidence: '' }];
    assert.deepStrictEqual(flippedIds(prev, [{ id: 'a', yes: false, evidence: '' }, { id: 'b', yes: true, evidence: '' }]), ['a']);
    const page = extractSitePage(body('x'), SITE);
    assert.deepStrictEqual(steadyAnswers(prev, [{ id: 'a', yes: false, evidence: '' }], [{ id: 'a', yes: true, evidence: '' }], page), [{ id: 'a', yes: true, evidence: '' }], 'not confirmed: kept');
    assert.deepStrictEqual(steadyAnswers(prev, [{ id: 'a', yes: false, evidence: '' }], null, page), [{ id: 'a', yes: false, evidence: '' }], 'second ask failed: as before');
    assert.strictEqual(scoreChangesFrom(undefined, [], { ownPageChanged: false, competitorsChanged: false }), null, 'first check: nothing to compare');

    console.log('repro-issue-63: scores hold when only the asking changed; real changes are explained ✓');
})().catch((e) => { console.error(e); process.exit(1); });
