// tests/visual-briefs-db.test.ts
// The Brand Designer's money SQL, on REAL Postgres — src/utils/visual-briefs.ts endRound and
// sweepStuckRounds. Brand Designer plan, Phase 1.
//
// WHY A DATABASE TEST. A round's AI credit is held at the click and must be settled exactly ONCE:
// charged if the AI produced something, refunded otherwise. The worker and the timeout sweep can both
// try to end the same round. The guarantee is one statement — UPDATE … FROM (SELECT … FOR UPDATE)
// … WHERE status = 'generating' RETURNING the OLD hold — and a mistake in it (returning the new,
// zeroed hold; matching a round that already ended) double-refunds or never refunds. Only Postgres
// can prove that statement, so it runs here.
//
// HOW. Copies of the four tables it touches (`LIKE … INCLUDING DEFAULTS`: real columns, no foreign
// keys) in a throwaway schema, on ONE connection with search_path set to it.
//
// ⚠️ Runs ONLY against a database on localhost (CI's rls job). db/client loads .env, and locally that
// is STAGING — this test must never create schemas there.
//
// Run:  npx tsx tests/visual-briefs-db.test.ts

import assert from 'node:assert';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { endRound, sweepStuckRounds } from '../src/utils/visual-briefs';
import { judgeVisualOrder } from '../src/utils/campaign-visual-order';

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    try {
        await fn();
        passed++; console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1;
    }
}

function isLocal(url: string | undefined): url is string {
    if (!url) return false;
    try { return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(url).hostname); }
    catch { return false; }
}

async function main() {
    console.log('Brand Designer — a round\'s credit is settled exactly once (real Postgres)');
    const url = process.env.NETLIFY_DATABASE_URL;
    if (!isLocal(url)) { console.log('  ⊘ skipped — no LOCAL database (CI rls job only; never staging/prod)'); return; }

    const schema = `visual_briefs_test_${Date.now()}`;
    const sql = postgres(url, { max: 1 });
    try {
        await sql.unsafe(`CREATE SCHEMA ${schema}`);
        for (const t of ['visual_briefs', 'visual_brief_options', 'ai_credit_balance', 'ai_credit_ledger']) {
            await sql.unsafe(`CREATE TABLE ${schema}.${t} (LIKE public.${t} INCLUDING DEFAULTS)`);
        }
        // INCLUDING ALL for this one: its unique (campaign, asset) pair is part of what is tested.
        await sql.unsafe(`CREATE TABLE ${schema}.campaign_assets (LIKE public.campaign_assets INCLUDING ALL)`);
        await sql.unsafe(`SET search_path TO ${schema}`);
        const db = drizzle({ client: sql }) as never;

        const ORG = 1;
        await sql.unsafe(`INSERT INTO ai_credit_balance (organisation_id, balance, held) VALUES (${ORG}, 10, 3)`);
        const brief = async (status: string, hold: number, startedAgo = '1 minute') => {
            const [r] = await sql.unsafe(
                `INSERT INTO visual_briefs (organisation_id, ai_assistant_id, title, status, rounds, credit_hold, generation_started_at)
                 VALUES ($1, 1, 't', $2, 1, $3, now() - $4::interval) RETURNING id`, [ORG, status, hold, startedAgo]);
            return Number(r.id);
        };
        const option = (briefId: number, status: string) => sql.unsafe(
            `INSERT INTO visual_brief_options (organisation_id, brief_id, round, source, status) VALUES ($1, $2, 1, 'stock', $3)`,
            [ORG, briefId, status]);
        const balance = async () => {
            const [r] = await sql.unsafe(`SELECT balance, held FROM ai_credit_balance WHERE organisation_id = ${ORG}`);
            return { balance: Number(r.balance), held: Number(r.held) };
        };
        const row = async (id: number) => (await sql.unsafe(`SELECT status, credit_hold, generation_note FROM visual_briefs WHERE id = ${id}`))[0];

        await check('a round whose AI produced nothing is refunded, ONCE, however many times it is ended', async () => {
            const id = await brief('generating', 1);
            await option(id, 'proposed');
            assert.strictEqual(await endRound(db, id, { chargeAi: false, note: 'no AI this time' }), true);
            assert.deepStrictEqual(await balance(), { balance: 11, held: 2 }, 'the hold goes back to the spendable balance');
            assert.strictEqual(await endRound(db, id, { chargeAi: false, note: 'again' }), false, 'a round that already ended matches nothing');
            assert.deepStrictEqual(await balance(), { balance: 11, held: 2 }, 'a second end must not refund twice');
            const r = await row(id);
            assert.strictEqual(r.status, 'in_review', 'it has an option waiting');
            assert.strictEqual(Number(r.credit_hold), 0);
            assert.strictEqual(r.generation_note, 'no AI this time', 'the second call wrote nothing');
        });

        await check('a round whose AI produced options is CHARGED, and a brief with nothing left is open again', async () => {
            const id = await brief('generating', 1);
            assert.strictEqual(await endRound(db, id, { chargeAi: true, note: null }), true);
            assert.deepStrictEqual(await balance(), { balance: 11, held: 1 }, 'charged: the hold is consumed, the balance does not come back');
            const [l] = await sql.unsafe(`SELECT delta, reason FROM ai_credit_ledger WHERE organisation_id = ${ORG} ORDER BY id DESC LIMIT 1`);
            assert.strictEqual(Number(l.delta), -1);
            assert.strictEqual(l.reason, 'image_generation');
            assert.strictEqual((await row(id)).status, 'open');
        });

        await check('an approved option keeps the brief approved through a later round', async () => {
            const id = await brief('generating', 0);
            await option(id, 'approved');
            await option(id, 'proposed');
            await endRound(db, id, { chargeAi: false, note: null });
            assert.strictEqual((await row(id)).status, 'approved');
        });

        await check('the sweep ends only STALE rounds, refunds them, and a worker finishing late settles nothing', async () => {
            const stale = await brief('generating', 1, '20 minutes');
            const fresh = await brief('generating', 0, '1 minute');
            const before = await balance();
            assert.strictEqual(await sweepStuckRounds(db, ORG), 1);
            assert.strictEqual((await row(stale)).status, 'open');
            assert.match(String((await row(stale)).generation_note), /Nothing was charged/);
            assert.strictEqual((await row(fresh)).status, 'generating', 'a round still inside its time is left alone');
            assert.deepStrictEqual(await balance(), { balance: before.balance + 1, held: before.held - 1 });
            assert.strictEqual(await endRound(db, stale, { chargeAi: true, note: null }), false,
                'the worker arriving after the sweep must not charge a round the user was told was free');
            assert.deepStrictEqual(await balance(), { balance: before.balance + 1, held: before.held - 1 });
        });
        // ── Phase 3: a campaign's picture order, judged from its brief ──────────────────────
        await check('an approved picture DELIVERS the order and joins the campaign once, however often it is judged', async () => {
            const id = await brief('in_review', 0);
            await sql.unsafe(`INSERT INTO visual_brief_options (organisation_id, brief_id, round, source, status, content_asset_id) VALUES (${ORG}, ${id}, 1, 'stock', 'approved', 501)`);
            await option(id, 'proposed');
            const order = { id: 9, organisationId: ORG, campaignId: 77, artefactId: id };
            const v1 = await judgeVisualOrder(db, order);
            assert.strictEqual(v1.kind, 'delivered');
            const v2 = await judgeVisualOrder(db, order);
            assert.strictEqual(v2.kind, 'delivered');
            const rows = await sql.unsafe(`SELECT content_asset_id FROM campaign_assets WHERE campaign_id = 77`);
            assert.deepStrictEqual(rows.map((x) => Number(x.content_asset_id)), [501], 'attached once, not once per judgement');
        });

        await check('waiting options are "in review"; cancelled before anything was made is FAILED (refunded)', async () => {
            const waiting = await brief('in_review', 0);
            await option(waiting, 'proposed');
            assert.strictEqual((await judgeVisualOrder(db, { id: 10, organisationId: ORG, campaignId: 78, artefactId: waiting })).kind, 'in_review');
            const [c] = await sql.unsafe(`INSERT INTO visual_briefs (organisation_id, ai_assistant_id, title, status, rounds) VALUES (${ORG}, 1, 't', 'cancelled', 0) RETURNING id`);
            assert.strictEqual((await judgeVisualOrder(db, { id: 11, organisationId: ORG, campaignId: 78, artefactId: Number(c.id) })).kind, 'failed');
            const [d] = await sql.unsafe(`INSERT INTO visual_briefs (organisation_id, ai_assistant_id, title, status, rounds) VALUES (${ORG}, 1, 't', 'cancelled', 2) RETURNING id`);
            assert.strictEqual((await judgeVisualOrder(db, { id: 12, organisationId: ORG, campaignId: 78, artefactId: Number(d.id) })).kind, 'rejected',
                'options were made and turned down — real work, not refunded');
            assert.strictEqual((await judgeVisualOrder(db, { id: 13, organisationId: 2, campaignId: 78, artefactId: waiting })).kind, 'rejected',
                'another organisation\'s brief is not found');
        });
    } finally {
        await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
        await sql.end();
    }
    console.log(`\n${passed} checks passed.`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
