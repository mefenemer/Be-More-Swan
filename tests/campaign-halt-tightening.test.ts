// tests/campaign-halt-tightening.test.ts
// Approving a halt said "Search targeting tightened" and changed nothing (prod, 2026-11-03: the
// owner's "Small creative & professional services firms" halt, 84 found, 38 cold). The halt's
// narrow_targeting carried no new description, and the executor reported success either way.
//
// Now a halt carries the new description it will write (shown on the card first), or pauses the
// search and says so. Both outcomes are tested here, against the executor itself.
//
// Run:  npx tsx tests/campaign-halt-tightening.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoveryCampaigns, discoveryJobs, discoverySchedules } from '../db/schema';
import {
    structuredTightening, toColdLead, usableIdea, proposeTightening, type ColdLead,
} from '../src/utils/halt-tightening';
import { buildHaltProposal, narrowTargetingBrief } from '../src/utils/campaign-proposer';
import { narrowTargetingExecutor } from '../src/utils/campaign-orders';
import { planOrderProblem } from '../src/utils/campaign-plan';
import { restoredMessage } from '../src/utils/campaign-decision-restore';

let passed = 0;
const pending: Array<Promise<void>> = [];
function check(name: string, fn: () => void | Promise<void>): void {
    pending.push((async () => {
        try {
            await fn();
            passed++; console.log(`  ✓ ${name}`);
        } catch (err) {
            console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1;
        }
    })());
}

// ── A database that records writes and answers reads from a queue ─────────────
interface Write { op: 'update' | 'delete'; table: unknown; set?: Record<string, unknown> }
function fakeDb(reads: unknown[][]) {
    const writes: Write[] = [];
    const chain = (resolve: () => unknown) => {
        const b: Record<string, unknown> = {};
        for (const m of ['from', 'where', 'orderBy', 'limit', 'innerJoin', 'groupBy', 'returning']) b[m] = () => b;
        b.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve().then(resolve).then(ok, bad);
        return b;
    };
    const db = {
        select: () => chain(() => reads.shift() ?? []),
        update: (table: unknown) => ({
            set: (set: Record<string, unknown>) => chain(() => { writes.push({ op: 'update', table, set }); return []; }),
        }),
        delete: (table: unknown) => chain(() => { writes.push({ op: 'delete', table }); return []; }),
    };
    return { db: db as never, writes };
}

const ctx = (brief: Record<string, unknown>) => ({
    organisationId: 7, campaignId: 1, orchestratorAssistantId: 2, campaignObjective: 'x',
    action: 'narrow_targeting' as const, brief, workItems: 0, targetAssistantId: 3, targetUserId: 4,
});
const IDEA = 'Small creative & professional services firms in the UK';
const NEW = 'Small UK creative studios and professional services firms with 2–20 staff, not agencies that sell to them';

console.log('halt tightening');

// ── 1. The proposal carries what approval will do ──────────────────────────────
const HIT = { discoveryCampaignId: 10, searchName: 'Small creative & professional services firms', total: 84, cold: 38, coldShare: 38 / 84 };

check('a halt with a tightening carries the new description AND the one it replaces', () => {
    const o = buildHaltProposal(HIT, { idea: NEW, previousIdea: IDEA }).orders.find((x) => x.action === 'narrow_targeting')!;
    assert.deepStrictEqual(o.brief, { discoveryCampaignId: 10, idea: NEW, previousIdea: IDEA });
});

check('a halt with no workable tightening says it will PAUSE — never an empty narrowing', () => {
    for (const t of [null, { idea: null, previousIdea: IDEA }]) {
        const o = buildHaltProposal(HIT, t).orders.find((x) => x.action === 'narrow_targeting')!;
        assert.deepStrictEqual(o.brief, { discoveryCampaignId: 10, pauseSearch: true });
    }
    assert.deepStrictEqual(narrowTargetingBrief(5, null), { discoveryCampaignId: 5, pauseSearch: true });
});

// ── 2. Approval does exactly that, and says so ─────────────────────────────────

check('approving a tightening rewrites the search to the shown description and says so', async () => {
    const { db, writes } = fakeDb([[{ id: 10, idea: IDEA, status: 'active' }]]);
    const r = await narrowTargetingExecutor(db, ctx({ discoveryCampaignId: 10, idea: NEW, previousIdea: IDEA }));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(writes.length, 1);
    assert.strictEqual(writes[0].table, discoveryCampaigns);
    assert.strictEqual(writes[0].set?.idea, NEW, 'the search was not rewritten to the description on the card');
    assert.ok(r.summary?.startsWith('Search description changed to:') && r.summary.includes('2–20 staff'), r.summary);
    assert.ok(!/tightened/i.test(r.summary ?? ''), 'still claims "tightened"');
});

check('a search the user reworded since the proposal is left alone, and the result says so', async () => {
    const { db, writes } = fakeDb([[{ id: 10, idea: 'My own new wording', status: 'active' }]]);
    const r = await narrowTargetingExecutor(db, ctx({ discoveryCampaignId: 10, idea: NEW, previousIdea: IDEA }));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(writes.length, 0, 'overwrote the user\'s newer wording');
    assert.ok(/not changed/.test(r.message ?? ''), r.message);
});

check('approving a pause pauses the search, its schedule and its queued runs — and changes nothing else', async () => {
    const { db, writes } = fakeDb([[{ id: 10, idea: IDEA, status: 'active' }]]);
    const r = await narrowTargetingExecutor(db, ctx({ discoveryCampaignId: 10, pauseSearch: true }));
    assert.strictEqual(r.ok, true);
    const status = writes.find((w) => w.table === discoveryCampaigns);
    assert.strictEqual(status?.set?.status, 'paused');
    assert.ok(!('idea' in (status?.set ?? {})), 'a pause rewrote the description');
    assert.ok(writes.some((w) => w.table === discoverySchedules), 'schedule left enabled on a paused search');
    assert.ok(writes.some((w) => w.op === 'delete' && w.table === discoveryJobs), 'queued runs left to run');
    assert.ok(/^Search paused, not changed/.test(r.summary ?? ''), r.summary);
});

check('a pause on a search that is not running writes nothing and says it was not changed', async () => {
    const { db, writes } = fakeDb([[{ id: 10, idea: IDEA, status: 'draft' }]]);
    const r = await narrowTargetingExecutor(db, ctx({ discoveryCampaignId: 10, pauseSearch: true }));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(writes.length, 0);
    assert.ok(/not changed and not running/.test(r.summary ?? ''), r.summary);
});

check('an empty narrowing (the pre-fix halt) is refused, never reported as tightened', async () => {
    const { db, writes } = fakeDb([[{ id: 10, idea: IDEA, status: 'active' }]]);
    const r = await narrowTargetingExecutor(db, ctx({ discoveryCampaignId: 10 }));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(writes.length, 0);
    assert.ok(/Nothing was changed/.test(r.message ?? ''), r.message);
});

check('an archived search is refused', async () => {
    const { db } = fakeDb([[{ id: 10, idea: IDEA, status: 'archived' }]]);
    const r = await narrowTargetingExecutor(db, ctx({ discoveryCampaignId: 10, idea: NEW }));
    assert.strictEqual(r.ok, false);
});

// ── 3. Where the description comes from ────────────────────────────────────────
const cold = (over: Partial<ColdLead>): ColdLead => ({ companyName: 'Co', reasons: ['too big'], prospectType: 'target_business', excludedBy: null, outsideArea: null, ...over });

check('the fallback writes only reasons at least two cold leads share', () => {
    assert.strictEqual(structuredTightening(IDEA, [cold({}), cold({})]), null, 'invented a tightening from free text alone');
    assert.strictEqual(structuredTightening(IDEA, [cold({ prospectType: 'aggregator' }), cold({})]), null, 'one lead is not a pattern');
    const t = structuredTightening(IDEA, [
        cold({ prospectType: 'aggregator' }), cold({ prospectType: 'aggregator' }),
        cold({ outsideArea: 'Ohio, United States' }), cold({ outsideArea: 'Paris, France' }),
        cold({ excludedBy: 'Companies with over 250 staff' }), cold({ excludedBy: 'Companies with over 250 staff' }),
    ])!;
    assert.ok(t.startsWith(`${IDEA}.`), 'the user\'s own description must come first, unchanged');
    assert.ok(t.includes('not directories or listing sites'), t);
    assert.ok(t.includes('based in the area named above'), t);
    assert.ok(t.includes('"Companies with over 250 staff"'), t);
});

check('an unscored card is not evidence', () => {
    assert.strictEqual(toColdLead('X', { scoringFailed: true, reasons: [] }), null);
    assert.deepStrictEqual(toColdLead('X', { reasons: ['r'], prospectType: 'media' })?.prospectType, 'media');
});

check('a rewrite identical to the current description, or empty, is not a tightening', () => {
    assert.strictEqual(usableIdea(` ${IDEA.toUpperCase()} `, IDEA), null);
    assert.strictEqual(usableIdea('', IDEA), null);
    assert.strictEqual(usableIdea(null, IDEA), null);
    assert.strictEqual(usableIdea(NEW, IDEA), NEW);
});

check('proposeTightening: model first, then the fallback, then null (→ pause)', async () => {
    const coldRows = [
        { companyName: 'A', card: { reasons: ['directory'], prospectType: 'aggregator' } },
        { companyName: 'B', card: { reasons: ['directory'], prospectType: 'aggregator' } },
    ];
    let a = fakeDb([[{ idea: IDEA }], coldRows]);
    assert.deepStrictEqual(await proposeTightening(a.db, 7, 10, new Date(), async () => NEW), { previousIdea: IDEA, idea: NEW });
    a = fakeDb([[{ idea: IDEA }], coldRows]);
    const fb = await proposeTightening(a.db, 7, 10, new Date(), async () => null);
    assert.ok(fb?.idea?.includes('not directories'), 'no structured fallback');
    a = fakeDb([[{ idea: IDEA }], [{ companyName: 'C', card: { reasons: ['meh'] } }]]);
    assert.deepStrictEqual(await proposeTightening(a.db, 7, 10, new Date(), async () => null), { previousIdea: IDEA, idea: null });
    a = fakeDb([[]]);
    assert.strictEqual(await proposeTightening(a.db, 7, 10, new Date(), async () => NEW), null, 'a missing search must not be proposed against');
});

// ── 4. GUI and chat: the same rules, the same words ────────────────────────────

check('a manual or chat narrowing with no new description is refused when filed', () => {
    const p = planOrderProblem({ action: 'narrow_targeting', quantity: 1, brief: { discoveryCampaignId: 10 } });
    assert.ok(p && /new description/.test(p), String(p));
    assert.strictEqual(planOrderProblem({ action: 'narrow_targeting', quantity: 1, brief: { discoveryCampaignId: 10, idea: NEW } }), null);
});

check('a restore says what approving will now do to the search', () => {
    const base = { kind: 'halt', expiresAt: new Date(Date.now() + 2 * 864e5), remeasured: true, belowThreshold: false, keptRejectReason: false };
    assert.ok(/If you approve/.test(restoredMessage({ ...base, searchChange: 'rewrite' })));
    assert.ok(/pause the search rather than change it/.test(restoredMessage({ ...base, searchChange: 'pause' })));
});

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

check('the Review card shows "Search now" → "Changes to", or the pause, under If you approve', () => {
    const js = read('assistants.js');
    const d = js.slice(js.indexOf('function _rqDecisionDetail('), js.indexOf('window._rqEditCampaignPlan'));
    assert.ok(js.includes("const _RQ_NARROW_LABELS = [['previousIdea', 'Search now'], ['idea', 'Changes to']];"));
    assert.ok(d.includes("o.action === 'narrow_targeting'") && d.includes('_RQ_NARROW_LABELS') && d.includes('_RQ_NARROW_PAUSE'), 'card ignores the narrowing brief');
});

check('the approve toast and the Add-work toast report the executor\'s own sentence', () => {
    const js = read('assistants.js');
    assert.ok(js.includes("placed.find((p) => p && p.action === 'narrow_targeting')"), 'approve toast does not say what happened to the search');
    const camp = read('netlify/functions/campaigns.ts');
    assert.ok(camp.includes('summary: r.summary, action: o.action'), 'decide does not return each order\'s summary');
    assert.ok(read('src/components/assistant-campaigns.js').includes("spec.key === 'narrow_targeting' && placed?.summary"));
});

check('nothing still claims a search was "tightened" without a write', () => {
    const orders = read('src/utils/campaign-orders.ts');
    assert.ok(!/summary: 'Search targeting tightened'/.test(orders));
    assert.ok(read('netlify/functions/chat-orchestrator.ts').includes('never that a search was tightened unless it was'));
});

Promise.all(pending).then(() => console.log(`\n${passed} passed`));
