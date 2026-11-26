// tests/shop-waitlist-db.test.ts
// "Tell me when it's back" on REAL Postgres (online shop Phase 2, slice 6; feature request #35,
// docs/online-shop-review-plan.md §12; src/utils/shop-waitlist.ts): joining once per person per product, only while
// sold out; the Team Chat question asked once, with the Social link; sending only buyable, claimed, refusals skipped,
// failures left waiting, batches; the answer handler; the sweep.
//
// HOW. Copies of the tables it touches (`LIKE … INCLUDING ALL`: columns, defaults, checks, indexes; no foreign keys) in
// a throwaway schema, search_path set to it. CI's database comes from db/schema.ts (drizzle push). The send route and
// sender are stubbed.
//
// ⚠️ Runs ONLY against a database on localhost (CI's rls job) — never staging/prod.
//
// Run:  npx tsx tests/shop-waitlist-db.test.ts

import assert from 'node:assert';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { closeDbPools } from '../db/client';
import { askBackInStock, joinWaitlist, productBuyable, sendBackInStock, sweepWaitlist, waitingCounts, SEND_BATCH } from '../src/utils/shop-waitlist';

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
function isLocal(url: string | undefined): url is string {
    if (!url) return false;
    try { return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(url).hostname); }
    catch { return false; }
}

async function main() {
    console.log('Back in stock: join while sold out, ask once, send from the owner\'s route (real Postgres)');
    const url = process.env.NETLIFY_DATABASE_URL;
    if (!isLocal(url)) { console.log('  ⊘ skipped — no LOCAL database (CI rls job only; never staging/prod)'); return; }

    const schema = `shop_waitlist_test_${Date.now()}`;
    const sql = postgres(url, { max: 1 });
    try {
        await sql.unsafe(`CREATE SCHEMA ${schema}`);
        for (const t of ['organisations', 'sites', 'org_products', 'product_options', 'shop_waitlist', 'audience_contacts', 'lead_opt_outs', 'suppression_list', 'team_messages', 'ai_assistants', 'master_assistants']) {
            await sql.unsafe(`CREATE TABLE ${schema}.${t} (LIKE public.${t} INCLUDING ALL)`);
        }
        await sql.unsafe(`SET search_path TO ${schema}`);
        const db = drizzle({ client: sql }) as never;
        const ORG = 8, SITE = 80;
        await sql.unsafe(`INSERT INTO organisations (id, name, slug) VALUES (${ORG}, 'Kudzu Candles', 'kudzu-wl')`);
        await sql.unsafe(`INSERT INTO sites (id, organisation_id, ai_assistant_id, slug, draft) VALUES (${SITE}, ${ORG}, 1, 'kudzu', '{}'::jsonb)`);
        await sql.unsafe(`INSERT INTO master_assistants (id, role_key, name) VALUES (500, 'social_media_manager', 'Social Media Manager')`);
        await sql.unsafe(`INSERT INTO ai_assistants (id, user_id, organisation_id, name, model, master_assistant_id) VALUES (900, 1, ${ORG}, 'Sophie', 'x', 500)`);
        const product = async (name: string, stock: number | null) => Number((await sql.unsafe(`INSERT INTO org_products (organisation_id, name, stock) VALUES (${ORG}, $1, $2) RETURNING id`, [name, stock]))[0].id);
        const setStock = (id: number, stock: number | null) => sql.unsafe(`UPDATE org_products SET stock = $1 WHERE id = ${id}`, [stock]);
        const join = (productId: number, email: string) => joinWaitlist(db, { orgId: ORG, siteId: SITE, productId, email });
        const sent: string[] = [];
        const deps = { resolveRoute: (async () => ({ route: { provider: 'gmail', from: null, replyTo: null, engagementTracked: false } })) as never, deliver: (async (_d: unknown, _r: unknown, _o: unknown, m: { to: string }) => { sent.push(m.to); return null; }) as never };
        const LAV = await product('Lavender candle', 0);

        await check('joining while sold out: once per person per product (any case), counted', async () => {
            assert.deepStrictEqual(await join(LAV, 'Sam@Example.com'), { ok: true, already: false });
            assert.deepStrictEqual(await join(LAV, 'sam@example.com'), { ok: true, already: true });
            assert.deepStrictEqual(await join(LAV, 'ana@example.com'), { ok: true, already: false });
            assert.strictEqual((await waitingCounts(db, ORG))[LAV], 2);
        });
        await check('refused: a bad address, a product in stock, another workspace\'s product', async () => {
            const bad = await join(LAV, 'nope');
            assert.ok(!bad.ok && bad.status === 400);
            const inStock = await product('Fig candle', 4);
            const r = await join(inStock, 'x@example.com');
            assert.ok(!r.ok && r.status === 409 && /back in stock now/.test(r.error));
            const other = Number((await sql.unsafe(`INSERT INTO org_products (organisation_id, name, stock) VALUES (${ORG + 1}, 'Theirs', 0) RETURNING id`))[0].id);
            const o = await join(other, 'x@example.com');
            assert.ok(!o.ok && o.status === 404);
        });
        await check('options decide: all sold out = not buyable, one left = buyable', async () => {
            const TEE = await product('T-shirt', null);
            await sql.unsafe(`INSERT INTO product_options (organisation_id, product_id, label, stock) VALUES (${ORG}, ${TEE}, 'S', 0), (${ORG}, ${TEE}, 'L', 0)`);
            assert.strictEqual((await productBuyable(db, ORG, TEE))?.buyable, false);
            await sql.unsafe(`UPDATE product_options SET stock = 2 WHERE product_id = ${TEE} AND label = 'L'`);
            assert.strictEqual((await productBuyable(db, ORG, TEE))?.buyable, true);
        });
        await check('sending while still sold out → refused, nobody emailed', async () => {
            const r = await sendBackInStock(db, { orgId: ORG, productId: LAV, deps });
            assert.ok(!r.ok && /still sold out/.test(r.error));
            assert.strictEqual(sent.length, 0);
        });
        await check('back in stock → the Shopkeeper asks ONCE in Team Chat, with a link to ask Social for a post', async () => {
            await setStock(LAV, 5);
            assert.strictEqual(await askBackInStock(db, { orgId: ORG, productId: LAV, name: 'Lavender candle', shopkeeperId: 77 }), 2);
            assert.strictEqual(await askBackInStock(db, { orgId: ORG, productId: LAV, name: 'Lavender candle', shopkeeperId: 77 }), 2);
            const q = await sql.unsafe(`SELECT body, question, link, from_assistant_id FROM team_messages WHERE organisation_id = ${ORG} AND kind = 'question'`);
            assert.strictEqual(q.length, 1, 'asked once while open');
            assert.strictEqual(q[0].body, 'Lavender candle is back in stock. Email the 2 people waiting to hear?');
            assert.deepStrictEqual([q[0].question.key, q[0].question.ref, q[0].from_assistant_id], ['back_in_stock', LAV, 77]);
            assert.deepStrictEqual([q[0].link.assistantId, q[0].link.chat, q[0].link.label], [900, true, 'Ask Sophie for a post']);
        });
        await check('send: everyone waiting emailed once, a refused address skipped (never emailed), list emptied', async () => {
            await sql.unsafe(`INSERT INTO lead_opt_outs (organisation_id, email) VALUES (${ORG}, 'ana@example.com')`);
            const r = await sendBackInStock(db, { orgId: ORG, productId: LAV, deps });
            assert.deepStrictEqual(r, { ok: true, sent: 1, skipped: 1, failed: 0, left: 0 });
            assert.deepStrictEqual(sent, ['sam@example.com']);
            assert.strictEqual((await sql.unsafe(`SELECT skip_reason FROM shop_waitlist WHERE email = 'ana@example.com'`))[0].skip_reason, 'opted_out');
            const again = await sendBackInStock(db, { orgId: ORG, productId: LAV, deps });
            assert.deepStrictEqual(again, { ok: true, sent: 0, skipped: 0, failed: 0, left: 0 });
            assert.strictEqual(sent.length, 1, 'nobody twice');
            assert.deepStrictEqual(await join(LAV, 'sam@example.com'), { ok: false, status: 409, error: 'Good news: it\'s back in stock now. Go back to buy it.' });
        });
        await check('no route → nobody emailed, everyone still waiting; a failed send stays waiting', async () => {
            const BEE = await product('Beeswax candle', 0);
            await join(BEE, 'one@example.com'); await join(BEE, 'two@example.com');
            await setStock(BEE, 3);
            const noRoute = await sendBackInStock(db, { orgId: ORG, productId: BEE, deps: { ...deps, resolveRoute: (async () => ({ error: 'Verify a sending domain.' })) as never } });
            assert.ok(!noRoute.ok && noRoute.error === 'Nobody was emailed: Verify a sending domain.');
            assert.strictEqual((await waitingCounts(db, ORG))[BEE], 2);
            const flaky = await sendBackInStock(db, { orgId: ORG, productId: BEE, deps: { ...deps, deliver: (async (_d: unknown, _r: unknown, _o: unknown, m: { to: string }) => { if (m.to === 'two@example.com') throw new Error('down'); return null; }) as never } });
            assert.deepStrictEqual(flaky, { ok: true, sent: 1, skipped: 0, failed: 1, left: 1 });
        });
        await check(`a long list goes ${SEND_BATCH} per click`, async () => {
            const BIG = await product('Big candle', 0);
            for (let i = 0; i < SEND_BATCH + 5; i++) await join(BIG, `p${i}@example.com`);
            await setStock(BIG, 100);
            const r = await sendBackInStock(db, { orgId: ORG, productId: BIG, deps });
            assert.deepStrictEqual(r.ok && [r.sent, r.left], [SEND_BATCH, 5]);
        });
        await check('the sweep: emailed rows go after 90 days, waiting rows after a year; newer ones stay', async () => {
            const OLD = await product('Old candle', 0);
            await join(OLD, 'ancient@example.com');
            await join(OLD, 'recent@example.com');
            await sql.unsafe(`UPDATE shop_waitlist SET created_at = now() - interval '366 days' WHERE email = 'ancient@example.com'`);
            await sql.unsafe(`UPDATE shop_waitlist SET notified_at = now() - interval '91 days' WHERE email = 'sam@example.com'`);
            assert.strictEqual(await sweepWaitlist(db), 2);
            const left = (await sql.unsafe(`SELECT email FROM shop_waitlist WHERE email IN ('ancient@example.com', 'recent@example.com', 'sam@example.com', 'ana@example.com')`)).map((r) => r.email).sort();
            assert.deepStrictEqual(left, ['ana@example.com', 'recent@example.com']);
        });
    } finally {
        await sql.unsafe(`SET search_path TO public`).catch(() => {});
        await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
        await sql.end();
        await closeDbPools();
    }
    console.log(`\n${passed} passed`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
