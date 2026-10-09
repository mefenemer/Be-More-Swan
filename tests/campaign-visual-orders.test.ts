// tests/campaign-visual-orders.test.ts
// A campaign commissions pictures from the Brand Designer — `commission_visuals`. Brand Designer plan
// Phase 3; campaign plan §10. The judge itself is proven on real Postgres in visual-briefs-db.test.ts.
//
// What is pinned, and how each would fail silently:
//   • Approving a campaign plan never spends an AI credit: only an all-free brief starts its round.
//   • The order is delivered by the user's approval on the Briefs tab, at once, through the ONE
//     settlement path — and the reconciler judges it as the backstop.
//   • The brief knows its campaign and order, so the picture joins that campaign's pictures.
//   • The Brand Designer is orchestratable and named on every surface that names an assignee (three
//     separate maps — a missing one shows a raw role key).
//   • The chat is told which orders this workspace can actually run, so it cannot plan work for an
//     assistant that is not hired.
//   • No import cycle: campaign-visual-order imports neither the reconciler nor visual-briefs.
//
// Run:  npx tsx tests/campaign-visual-orders.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAMPAIGN_ORDER_ACTIONS, ORDER_ACTION_SPECS, orderWorkItems } from '../src/config/campaign-vocab';
import { ORCHESTRATABLE_ROLE_KEYS, BRAND_DESIGNER_ROLE_KEY } from '../src/constants/roles';
import { ORDER_ROLE_LABELS, normalisePlanOrders, planOrderProblem } from '../src/utils/campaign-plan';

let passed = 0;
function check(name: string, fn: () => void): void {
    try {
        fn();
        passed++; console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1;
    }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
function code(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}
function span(text: string, start: string, end: string, what: string): string {
    const a = text.indexOf(start);
    assert.notStrictEqual(a, -1, `Could not find ${what} — the anchor ${JSON.stringify(start)} is gone.`);
    const b = text.indexOf(end, a + start.length);
    assert.notStrictEqual(b, -1, `Could not find the end of ${what}.`);
    return text.slice(a, b);
}

const visual = code(read('src/utils/campaign-visual-order.ts'));
const orders = code(read('src/utils/campaign-orders.ts'));

console.log('\n──── the order ────');

check('one brief per order, priced in tasks, artefact = the brief, to the Brand Designer only', () => {
    assert.ok((CAMPAIGN_ORDER_ACTIONS as readonly string[]).includes('commission_visuals'));
    const spec = ORDER_ACTION_SPECS.commission_visuals;
    assert.strictEqual(spec.roleKey, BRAND_DESIGNER_ROLE_KEY);
    assert.strictEqual(spec.artefactKind, 'visual_brief');
    assert.strictEqual(spec.takesQuantity, false);
    assert.strictEqual(orderWorkItems('commission_visuals', 9), 1, 'a quantity cannot multiply the price of one brief');
    assert.ok(ORCHESTRATABLE_ROLE_KEYS.includes(BRAND_DESIGNER_ROLE_KEY));
    assert.match(spec.description, /AI images wait for you/, 'the user must know approving the plan does not spend AI credits');
});

check('a plan keeps the picture fields, drops junk, and refuses a picture with nothing to show', () => {
    const [o] = normalisePlanOrders([{
        action: 'commission_visuals', show: 'A bright studio', headline: 'Booking now open', purpose: 'blog_header',
        aspectRatio: '16:9', sources: ['stock', 'canva', 'brand_card'], mustAvoid: 'suits', invented: 'x',
    }]);
    assert.deepStrictEqual(o.brief, {
        show: 'A bright studio', headline: 'Booking now open', mustAvoid: 'suits', purpose: 'blog_header', aspectRatio: '16:9',
        sources: ['stock', 'brand_card'],
    });
    const [bad] = normalisePlanOrders([{ action: 'commission_visuals', purpose: 'ad' }]);
    assert.match(String(planOrderProblem(bad)), /needs what the picture should show/);
    const [junk] = normalisePlanOrders([{ action: 'commission_visuals', show: 'x', purpose: 'billboard', sources: ['canva'] }]);
    assert.ok(!('purpose' in junk.brief) && !('sources' in junk.brief), 'unknown values are dropped, so the designer\'s defaults apply');
});

check('the migration widens BOTH checks as supersets, in one transaction, and moves "works with" only from its exact old value', () => {
    const sql = read('db/z-campaign-visuals.sql');
    assert.match(sql, /BEGIN;[\s\S]*COMMIT;/);
    const prior = read('db/z-campaign-email-orders.sql').match(/artefact_kind IN \(([\s\S]*?)\)\)/)![1].replace(/\s/g, '').split(',');
    const next = sql.match(/artefact_kind IN \(([\s\S]*?)\)\)/)![1].replace(/\s/g, '').split(',');
    for (const k of prior) assert.ok(next.includes(k), `${k} was dropped — existing orders would fail the re-added check`);
    assert.ok(next.includes("'visual_brief'"));
    assert.match(sql, /CHECK \(origin IN \('user', 'chat', 'campaign'\)\)/);
    assert.match(sql, /WHERE role_key = 'brand_designer' AND works_with = '\["standalone"\]'::jsonb/);
    assert.match(sql, /NOT \(works_with \? 'brand_designer'\)/);
    assert.match(read('db/schema.ts'), /'newsletter_sequence','newsletter_issue','visual_brief'\)`\)/);
});

console.log('\n──── placing it never spends an AI credit ────');

check('the executor starts a round ONLY when every source is free', () => {
    const ex = span(orders, 'commission_visuals: async (db, ctx, orderId) => {', '\n    },\n', 'the executor');
    assert.match(ex, /if \(made\.allFree\) \{[\s\S]*startRound\(/);
    assert.ok(ex.indexOf('startRound(') > ex.indexOf('if (made.allFree)'), 'a brief with AI images must wait for the user\'s click');
    assert.match(ex, /artefactKind: 'visual_brief', artefactId: made\.briefId/);
    assert.match(ex, /endRound\(db, made\.briefId, \{ chargeAi: false/, 'a lost wake-up is ended at once, never left spinning');
    const create = span(visual, 'export async function createBriefForOrder', '\n}\n', 'createBriefForOrder');
    assert.match(create, /allFree: sourcesAreFree\(n\.brief\.sources\)/, 'one definition of free — AI video counts as paid');
    assert.match(create, /origin: 'campaign', campaignId: ctx\.campaignId, campaignOrderId: orderId/);
    assert.match(create, /normaliseBrief\(/, 'the same normaliser as the tab and the chat');
    assert.match(create, /mood: campaign\.tone/, 'the campaign\'s tone is the picture\'s mood');
});

console.log('\n──── delivered by the user\'s choice ────');

check('approving or cancelling settles the order at once, through the one settlement path, lazily imported', () => {
    const vb = code(read('src/utils/visual-briefs.ts'));
    assert.match(vb, /if \(brief\.campaignOrderId\) await settleCampaignOrder\(db, brief\.id\)/);
    const cancel = span(vb, 'export async function cancelBrief', '\n}\n', 'cancelBrief');
    assert.match(cancel, /await settleCampaignOrder\(db, briefId\)/);
    const fn = span(vb, 'async function settleCampaignOrder', '\n}\n', 'settleCampaignOrder');
    assert.match(fn, /import\('\.\/campaign-reconciler'\)/, 'a static import would close a cycle through campaign-orders');
    assert.match(fn, /settleVisualOrder\(db, briefId, settleOrderNow\)/);
    assert.match(fn, /catch \(err\)/, 'the decision is saved already — a failed settle must not undo it');
    const settle = span(visual, 'export async function settleVisualOrder', '\n}\n', 'settleVisualOrder');
    assert.match(settle, /verdict\.kind === 'delivered' \|\| verdict\.kind === 'rejected' \|\| verdict\.kind === 'failed'/,
        'only a FINAL verdict settles from here');
});

check('the reconciler judges picture orders as the backstop', () => {
    const rec = code(read('src/utils/campaign-reconciler.ts'));
    assert.match(rec, /order\.action === 'commission_visuals'\s*\? await judgeVisualOrder\(db, order\)/);
    const judge = span(visual, 'export async function judgeVisualOrder', '\n}\n', 'judgeVisualOrder');
    assert.match(judge, /eq\(visualBriefs\.organisationId, order\.organisationId\)/, 'org-scoped');
    assert.ok(judge.indexOf("count('approved') > 0") < judge.indexOf("brief.status === 'cancelled'"),
        'an approved picture wins over a later cancel — it is in the library and the campaign');
});

check('no import cycle: the bridge module imports neither the reconciler nor visual-briefs', () => {
    assert.ok(!/from '\.\/campaign-reconciler'/.test(visual));
    assert.ok(!/from '\.\/visual-briefs'/.test(visual));
});

console.log('\n──── named everywhere, offered only when hired ────');

check('every assignee map names the Brand Designer', () => {
    assert.strictEqual(ORDER_ROLE_LABELS.brand_designer, 'Brand Designer');
    assert.match(read('src/utils/campaign-mirror.ts'), /brand_designer: 'Brand Designer'/);
    const reg = read('src/components/disruptive-ui-registry.js');
    const roleLabel = span(reg, 'const ROLE_LABEL = {', '};', 'the plan card\'s ROLE_LABEL');
    assert.match(roleLabel, /brand_designer: 'Brand Designer'/, 'without it the plan card HIDES the order');
});

check('the chat is told which orders can run here, and how to write a picture order', () => {
    const plan = code(read('src/utils/campaign-plan.ts'));
    assert.match(plan, /async function briefableLine/);
    assert.match(plan, /spec\.roleKey === HUMAN_ROLE_KEY \|\| hired\.has\(spec\.roleKey\)/);
    assert.match(plan, /\$\{await briefableLine\(db, organisationId\)\}/);
    const orch = read('netlify/functions/chat-orchestrator.ts');
    assert.match(orch, /- Brand Designer \("commission_visuals"\)/);
    assert.match(orch, /"commission_visuals" MUST carry "show"/);
    assert.match(orch, /\| "ab_test_posts" \| "commission_visuals",/);
    assert.match(orch, /\| "brand_designer" \| "human",/);
    assert.match(orch, /BRIEFS FROM CAMPAIGNS\./, 'the Brand Designer\'s own chat knows where those briefs came from');
});

check('the plan card and Add work both say AI images wait for a click', () => {
    const reg = read('src/components/disruptive-ui-registry.js');
    assert.match(reg, /const pictureNote = o\.action === 'commission_visuals'/);
    assert.match(reg, /AI images and video only when you press "Make options" on its Briefs tab/);
    assert.match(reg, /sources && !sources\.some\(\(x\) => x === 'ai_image' \|\| x === 'ai_video'\)/, 'a plan with AI video is not "made straight away"');
    const tab = read('src/components/assistant-campaigns.js');
    assert.match(tab, /commission_visuals: \{ field: 'show'/);
    assert.match(tab, /data-cmp-aw-ai="\$\{id\}"/);
    assert.match(tab, /if \(!brief\.show && !headline\) \{ say\(id, 'Say what the picture should show/);
    assert.match(read('src/generated/platform-constants.js'), /commission_visuals/, 'run `npm run gen:constants` — the browser reads the generated file');
});

check('the Briefs tab says which campaign a brief is for', () => {
    const tab = read('src/components/assistant-briefs.js');
    assert.match(tab, /For the campaign “\$\{esc\(b\.campaign\.objective\)\}”/);
    const vb = code(read('src/utils/visual-briefs.ts'));
    assert.match(vb, /inArray\(campaigns\.id, campaignIds\)/);
    assert.match(vb, /eq\(campaigns\.organisationId, orgId\)/);
});

console.log(`\n${passed} checks passed.`);
