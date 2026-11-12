// tests/system-review.test.ts — System Map Phase 3 (docs/system-map-plan.md): "Better options".
// Sources only from the search tool, decisions respected, checks queue once and can't hang, page and
// chat share one validator. No database, no model calls: pure functions and source scans.
// Run:  npx tsx tests/system-review.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    REVIEWABLE_SYSTEMS, parseReview, normaliseUrl, buildReviewPrompt, reviewState, attachReviews, validateReviewRequest,
    reviewContextFor, STALE_REVIEW_MS, type ReviewRow,
} from '../src/utils/system-review';
import { SERVICES } from '../src/utils/system-registry';
import { SERVICE_UNIT_PRICE_USD } from '../src/utils/ai-usage';
import { systemForUsageModel } from '../src/utils/system-map';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const keys = SERVICES.map((s) => s.key);

console.log('\nSystem Map — better options');

const answer = (o: unknown) => `Here you go:\n${JSON.stringify(o)}\nThanks`;
const searched = ['https://www.runwayml.com/pricing/', 'https://example.com/bench?utm_source=x'];

check('parse: keeps a URL only when the search returned it (trailing slash, utm ignored)', () => {
    const r = parseReview(answer({
        verdict: 'consider', summary: 'Kling is fine; Runway is cheaper.',
        alternatives: [
            { name: 'Runway Gen-4', url: 'https://runwayml.com/pricing', betterFor: ['price', 'nonsense'], detail: 'd', priceNote: '£', switchingEffort: 'low' },
            { name: 'Made-up Co', url: 'https://made-up.example/pricing', betterFor: ['quality'], detail: 'd', switchingEffort: 'huge' },
        ],
    }), searched)!;
    assert.strictEqual(r.alternatives[0].url, 'https://www.runwayml.com/pricing/', 'www and slash differences still match the searched URL');
    assert.strictEqual(r.alternatives[1].url, null, 'a URL the search never returned is dropped');
    assert.deepStrictEqual(r.alternatives[0].betterFor, ['price']);
    assert.strictEqual(r.alternatives[1].switchingEffort, 'medium');
    assert.deepStrictEqual(r.sources, ['https://www.runwayml.com/pricing/']);
});

check('parse: "switch" with nothing to show becomes "keep"; junk is null', () => {
    assert.strictEqual(parseReview(answer({ verdict: 'switch', summary: 'x', alternatives: [] }), [])!.verdict, 'keep');
    assert.strictEqual(parseReview('no json here', []), null);
    assert.strictEqual(parseReview(answer({ verdict: 'maybe', summary: 'x' }), []), null);
    assert.strictEqual(parseReview(answer({ verdict: 'keep', summary: '' }), []), null);
    assert.strictEqual(parseReview(answer({ verdict: 'consider', summary: 's', alternatives: Array(6).fill({ name: 'A' }) }), [])!.alternatives.length, 3);
});

check('parse: a newline the citation split put inside a JSON string still parses', () => {
    const broken = '{"verdict": "keep", "summary": "Fal is fine at our\nspend.", "alternatives": []}';
    const r = parseReview(broken, []);
    assert.ok(r, 'a raw newline inside a string must not lose the whole review');
    assert.strictEqual(r!.summary, 'Fal is fine at our spend.');
});

check('normaliseUrl', () => {
    assert.strictEqual(normaliseUrl('https://Example.com/a/?utm_medium=x#top'), 'https://example.com/a');
    assert.strictEqual(normaliseUrl('not a url'), '');
});

check('the prompt carries purpose, spend, models, bills, decisions and the last summary', () => {
    const p = buildReviewPrompt(reviewContextFor({
        name: 'Fal.ai', purpose: 'AI images and video', category: 'AI', version: { api: 'Queue API' },
        models: [{ model: 'fal-ai/flux-2-pro', spend30Gbp: 19.12, roles30: ['social_media'] }],
        spend: { total30Gbp: 59.89 }, fixedCosts: [{ label: 'Pro', currency: 'USD', amountMonthly: 19, endedOn: null }, { label: 'Old', currency: 'USD', amountMonthly: 5, endedOn: '2026-01-01' }],
        decisions: [{ decision: 'AI images use FLUX.2 Pro (bake-off 2026-11-02).' }], review: { summary: 'Keep fal.' },
    }, { social_media: 'Social Media Assistant' }));
    for (const bit of ['AI images and video', '£59.89', 'fal-ai/flux-2-pro: £19.12, used by Social Media Assistant', 'Pro: USD 19.00/month', 'FLUX.2 Pro (bake-off', 'LAST CHECK SAID: Keep fal.']) {
        assert.ok(p.includes(bit), `prompt is missing "${bit}"`);
    }
    assert.ok(!p.includes('Old: USD'), 'an ended bill is not what we pay now');
});

check('the system prompt tells the model to respect decisions and allows "keep"', () => {
    const src = read('src/utils/system-review.ts');
    assert.ok(/Never suggest something a decision says was turned down/.test(src));
    assert.ok(/say "keep"\. That is a good answer/.test(src));
});

check('an answer that never searched is retried once, then refused — never stored as a result', () => {
    const src = read('src/utils/system-review.ts');
    const run = src.slice(src.indexOf('export async function runSystemReview'));
    assert.ok(/let res = await ask\(`\$\{SEARCH_FIRST\}/.test(run), 'the first ask must open with the search-first instruction');
    assert.ok(/if \(res\.searchCount === 0\) \{\s*res = await ask\(`\$\{SEARCH_RETRY\}/.test(run), 'no search → one retry');
    const refuse = run.indexOf("if (res.searchCount === 0) throw new Error(");
    assert.ok(refuse > 0 && refuse < run.indexOf('parseReview('), 'a second unsearched answer must fail before it is parsed and stored');
    // Each attempt is its own gateway call, and the gateway records that call's searches (awaited).
    assert.strictEqual((run.match(/await ask\(/g) || []).length, 2, 'both attempts go through the gateway, which logs their searches');
});

check('a check stuck queued/running past 20 minutes reads as stalled', () => {
    const now = new Date('2026-11-12T12:00:00Z');
    assert.strictEqual(reviewState({ status: 'running', createdAt: new Date(now.getTime() - STALE_REVIEW_MS - 1000) }, now), 'stalled');
    assert.strictEqual(reviewState({ status: 'queued', createdAt: new Date(now.getTime() - 60_000) }, now), 'queued');
    assert.strictEqual(reviewState({ status: 'done', createdAt: new Date(0) }, now), 'done');
});

const row = (o: Partial<ReviewRow>): ReviewRow => ({ id: 1, systemKey: 'fal', status: 'done', verdict: 'keep', summary: 's', alternatives: [], sources: [], model: null, searchCount: 0, error: null, trigger: 'manual', createdAt: '2026-11-01T00:00:00.000Z', finishedAt: null, ...o });
check('attach: shows the last finished check, plus a newer attempt in progress or failed', () => {
    const now = new Date('2026-11-12T12:00:00Z');
    const [fal, neon, auth] = attachReviews([{ key: 'fal' }, { key: 'neon' }, { key: 'auth' }], [
        row({ id: 3, status: 'running', createdAt: '2026-11-12T11:59:00.000Z' }),
        row({ id: 2, status: 'done', verdict: 'consider' }),
        row({ id: 5, systemKey: 'neon', status: 'failed', error: 'cut off' }),
    ], [{ id: 1, systemKey: 'fal', decision: 'FLUX.2', createdAt: 'x' }], now);
    assert.strictEqual(fal.review?.id, 2);
    assert.strictEqual(fal.reviewAttempt?.state, 'running');
    assert.strictEqual(fal.decisions.length, 1);
    assert.strictEqual(neon.review, null);
    assert.strictEqual(neon.reviewAttempt?.error, 'cut off');
    assert.strictEqual(auth.reviewable, false);
});

check('validator: check_now keeps only reviewable systems; decisions are trimmed and bounded', () => {
    const v = validateReviewRequest({ action: 'check_now', systemKeys: ['fal', 'auth', 'gmail', 'fal'] }, keys);
    assert.deepStrictEqual((v as any).ok.systemKeys, ['fal']);
    assert.strictEqual((validateReviewRequest({ action: 'check_now', systemKeys: 'all' }, keys) as any).ok.systemKeys.length, REVIEWABLE_SYSTEMS.length);
    assert.ok('error' in validateReviewRequest({ action: 'check_now', systemKeys: ['auth'] }, keys));
    assert.strictEqual((validateReviewRequest({ action: 'add_decision', systemKey: 'fal', decision: '  keep   FLUX ' }, keys) as any).ok.decision, 'keep FLUX');
    assert.ok('error' in validateReviewRequest({ action: 'add_decision', systemKey: 'fal', decision: 'x'.repeat(501) }, keys));
    assert.ok('error' in validateReviewRequest({ action: 'add_decision', systemKey: 'nope', decision: 'fine' }, keys));
    assert.ok('error' in validateReviewRequest({ action: 'retire_decision', id: -1 }, keys));
});

check('every reviewable system is on the registry, and none is a connector', () => {
    for (const k of REVIEWABLE_SYSTEMS) {
        const s = SERVICES.find((x) => x.key === k);
        assert.ok(s, `${k} is not in the registry`);
        assert.notStrictEqual(s!.tier, 'connector', `${k} is a customer connector`);
    }
});

check('web searches are priced, mapped to Anthropic and logged once, by the gateway, for every grounded call', () => {
    assert.strictEqual(SERVICE_UNIT_PRICE_USD['anthropic-web-search']?.fallback, 0.01);
    assert.strictEqual(systemForUsageModel('anthropic-web-search'), 'anthropic');
    const gw = read('src/lib/ai-gateway.ts');
    const fee = gw.slice(gw.indexOf('async function recordSearchFee('), gw.indexOf('// ── Web search ──'));
    assert.ok(/model:\s+'anthropic-web-search'[\s\S]{0,200}serviceUnitPriceUsd\('anthropic-web-search'\)/.test(fee), 'priced per search');
    assert.ok(/await logAiUsage\(/.test(fee), 'awaited: a background review can be frozen as soon as it returns');
    assert.ok(/recordUsage\(req, tokensIn, tokensOut, model\);\s*await recordSearchFee\(req, searches\);/.test(gw), 'the grounded path records the fee');
    assert.ok(!/anthropic-web-search|logAiUsage\(/.test(read('src/utils/system-review.ts')), 'the review must not log it again');
});

check('the worker needs the cron secret, runs two at a time and stops starting at 12 minutes', () => {
    const w = read('netlify/functions/system-review-background.ts');
    assert.ok(w.includes("process.env.CRON_TRIGGER_SECRET") && w.includes('Unauthorized'));
    assert.ok(/CONCURRENCY = 2/.test(w) && /12 \* 60_000/.test(w));
    assert.ok(w.includes("eq(systemReviews.status, 'queued')"), 'only queued rows run — a replayed request can\'t run a check twice');
});

check('monthly schedule is in netlify.toml', () => {
    assert.ok(/\[functions\.system-review-monthly\]\s*\n\s*schedule = "0 5 2 \* \*"/.test(read('netlify.toml')));
});

check('a check that cannot start is marked failed, not left queued', () => {
    const page = read('netlify/functions/admin-system-map.ts');
    const at = page.indexOf('startReviewWorker(');
    assert.ok(at > 0 && page.indexOf("status: 'failed', error: problem", at) > at);
});

check('chat cards go through the same validator and the page endpoint', () => {
    const chat = read('netlify/functions/admin-systems-chat.ts');
    assert.ok(chat.includes('validateReviewRequest(body'));
    assert.ok(!/db\.(insert|update|delete)\(/.test(chat));
    assert.ok(read('netlify/functions/admin-system-map.ts').includes('validateReviewRequest(body, known)'));
});

check('SQL and Drizzle mirror agree; seeded decisions insert once', () => {
    const sqlFile = read('db/z-system-reviews.sql');
    assert.ok(sqlFile.includes('CREATE TABLE IF NOT EXISTS system_reviews') && sqlFile.includes('CREATE TABLE IF NOT EXISTS system_decisions'));
    assert.ok(/WHERE NOT EXISTS \(SELECT 1 FROM system_decisions/.test(sqlFile));
    const schema = read('db/schema.ts');
    assert.ok(schema.includes('pgTable("system_reviews"') && schema.includes('pgTable("system_decisions"'));
});

check('a check that ran no search never claims to come from one', () => {
    const js = read('src/components/admin-system-map.js');
    assert.ok(/r\.searchCount > 0\s*\?\s*`An opinion from/.test(js));
    assert.ok(js.includes('No web search was run for this check'));
});

check('the drawer escapes what the model wrote', () => {
    const js = read('src/components/admin-system-map.js');
    for (const f of ['x.name', 'x.detail', 'x.priceNote', 'r.summary', 'd.decision', 'x.url', 'a.error']) assert.ok(js.includes(`esc(${f}`), `${f} must go through esc()`);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}\n`);
