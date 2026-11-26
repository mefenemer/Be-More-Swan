// tests/shop-first-order-flow-db.test.ts
// "First order" email flows on REAL Postgres (online shop Phase 2, slice 4b; feature request #35,
// docs/online-shop-review-plan.md §12). src/utils/shop-first-order-flow.ts enrolShopBuyer: a buyer who ticked
// "Send me news" joins the first-order flow on their FIRST order only (an earlier order from the same address, in
// any case, means not first), a newly subscribed repeat buyer gets the welcome flow instead, a refused address gets
// nothing, and the database allows the new trigger but only ONE first-order flow switched on.
//
// HOW. Copies of newsletter_sequences, newsletter_sequence_steps, newsletter_sequence_enrolments and site_orders
// (`LIKE … INCLUDING ALL`: columns, defaults, the trigger CHECK and the unique indexes; no foreign keys) in a
// throwaway schema, search_path set to it. CI's database comes from db/schema.ts (drizzle push), so the CHECK and
// the one-on index here are the schema's.
//
// ⚠️ Runs ONLY against a database on localhost (CI's rls job) — never staging/prod.
//
// Run:  npx tsx tests/shop-first-order-flow-db.test.ts

import assert from 'node:assert';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { closeDbPools } from '../db/client';
import { enrolShopBuyer, isFirstOrder } from '../src/utils/shop-first-order-flow';
import { enrolInSequence } from '../src/utils/newsletter-sequence';

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
    console.log('First-order email flows: first order only, welcome otherwise, one flow on (real Postgres)');
    const url = process.env.NETLIFY_DATABASE_URL;
    if (!isLocal(url)) { console.log('  ⊘ skipped — no LOCAL database (CI rls job only; never staging/prod)'); return; }

    const schema = `shop_first_order_test_${Date.now()}`;
    const sql = postgres(url, { max: 1 });
    try {
        await sql.unsafe(`CREATE SCHEMA ${schema}`);
        for (const t of ['newsletter_sequences', 'newsletter_sequence_steps', 'newsletter_sequence_enrolments', 'site_orders']) {
            await sql.unsafe(`CREATE TABLE ${schema}.${t} (LIKE public.${t} INCLUDING ALL)`);
        }
        await sql.unsafe(`SET search_path TO ${schema}`);
        const db = drizzle({ client: sql }) as never;
        const ORG = 9, OTHER = 10;

        const flow = async (org: number, trigger: string, on: boolean, name: string) => {
            const [s] = await sql.unsafe(`INSERT INTO newsletter_sequences (organisation_id, name, trigger_event, is_enabled) VALUES ($1, $2, $3, $4) RETURNING id`, [org, name, trigger, on]);
            await sql.unsafe(`INSERT INTO newsletter_sequence_steps (organisation_id, sequence_id, step_number, delay_days, subject, body_markdown) VALUES ($1, $2, 1, 0, 'Hello', 'Thanks')`, [org, s.id]);
            return Number(s.id);
        };
        const order = async (org: number, email: string) => {
            const [r] = await sql.unsafe(
                `INSERT INTO site_orders (site_id, organisation_id, stripe_account_id, checkout_session_id, item_name, quantity, amount_total, currency, customer_email, status)
                 VALUES (1, $1, 'acct_x', 'cs_' || md5(random()::text), 'Mug', 1, 800, 'gbp', $2, 'paid') RETURNING id`, [org, email]);
            return Number(r.id);
        };
        const enrolledIn = async (contactId: number) => (await sql.unsafe(
            `SELECT s.trigger_event FROM newsletter_sequence_enrolments e JOIN newsletter_sequences s ON s.id = e.sequence_id WHERE e.contact_id = ${contactId} ORDER BY e.id`)).map((r) => r.trigger_event);

        const firstOrderFlow = await flow(ORG, 'first_order', true, 'First order thank-you');
        await flow(ORG, 'subscribed', true, 'Welcome');

        await check('first order + newly subscribed → the first-order flow, and NOT the welcome flow as well', async () => {
            const id = await order(ORG, 'new@example.com');
            const r = await enrolShopBuyer(db, { organisationId: ORG, email: 'new@example.com', orderId: id, audience: { result: 'added', contactId: 101 } });
            assert.strictEqual(r, 'first_order');
            assert.deepStrictEqual(await enrolledIn(101), ['first_order']);
        });
        await check('their second order: nothing more (already subscribed, not first)', async () => {
            const id = await order(ORG, 'new@example.com');
            assert.strictEqual(await isFirstOrder(db, { organisationId: ORG, email: 'new@example.com', orderId: id }), false);
            const r = await enrolShopBuyer(db, { organisationId: ORG, email: 'new@example.com', orderId: id, audience: { result: 'already', contactId: 101, status: 'subscribed' } });
            assert.strictEqual(r, 'none');
            assert.deepStrictEqual(await enrolledIn(101), ['first_order']);
        });
        await check('an existing subscriber\'s first order → the first-order flow', async () => {
            const id = await order(ORG, 'list@example.com');
            const r = await enrolShopBuyer(db, { organisationId: ORG, email: 'list@example.com', orderId: id, audience: { result: 'already', contactId: 102, status: 'subscribed' } });
            assert.strictEqual(r, 'first_order');
        });
        await check('bought before without ticking (address in another case), ticks now → welcome flow, not first-order', async () => {
            await order(ORG, 'Repeat@Example.com');
            const id = await order(ORG, 'repeat@example.com');
            const r = await enrolShopBuyer(db, { organisationId: ORG, email: 'repeat@example.com', orderId: id, audience: { result: 'added', contactId: 103 } });
            assert.strictEqual(r, 'welcome');
            assert.deepStrictEqual(await enrolledIn(103), ['subscribed']);
        });
        await check('another workspace\'s order with the same address does not make it "not first"', async () => {
            await order(OTHER, 'both@example.com');
            const id = await order(ORG, 'both@example.com');
            assert.strictEqual(await isFirstOrder(db, { organisationId: ORG, email: 'both@example.com', orderId: id }), true);
        });
        await check('a refused address (unsubscribed) or no ticked box → nothing', async () => {
            const id = await order(ORG, 'gone@example.com');
            assert.strictEqual(await enrolShopBuyer(db, { organisationId: ORG, email: 'gone@example.com', orderId: id, audience: { result: 'already', contactId: 104, status: 'unsubscribed' } }), 'none');
            assert.strictEqual(await enrolShopBuyer(db, { organisationId: ORG, email: 'gone@example.com', orderId: id, audience: null }), 'none');
            assert.deepStrictEqual(await enrolledIn(104), []);
        });
        await check('first-order flow switched off → a newly subscribed first-time buyer gets the welcome flow', async () => {
            await sql.unsafe(`UPDATE newsletter_sequences SET is_enabled = false WHERE id = ${firstOrderFlow}`);
            const id = await order(ORG, 'offflow@example.com');
            const r = await enrolShopBuyer(db, { organisationId: ORG, email: 'offflow@example.com', orderId: id, audience: { result: 'added', contactId: 105 } });
            assert.strictEqual(r, 'welcome');
            await sql.unsafe(`UPDATE newsletter_sequences SET is_enabled = true WHERE id = ${firstOrderFlow}`);
        });
        await check('review #903: a sign-up form still linked to a first-order flow by id never enrols anybody into it', async () => {
            const r = await enrolInSequence(db, { organisationId: ORG, contactId: 106, email: 'form@example.com', sequenceId: firstOrderFlow });
            assert.deepStrictEqual(r, { enrolled: false, reason: 'no_sequence' });
            assert.deepStrictEqual(await enrolledIn(106), []);
        });
        await check('review #903: first-order flow on but with no enabled emails → a newly subscribed buyer still gets the welcome flow', async () => {
            await sql.unsafe(`UPDATE newsletter_sequence_steps SET is_enabled = false WHERE sequence_id = ${firstOrderFlow}`);
            const id = await order(ORG, 'nosteps@example.com');
            const r = await enrolShopBuyer(db, { organisationId: ORG, email: 'nosteps@example.com', orderId: id, audience: { result: 'added', contactId: 107 } });
            assert.strictEqual(r, 'welcome');
            assert.deepStrictEqual(await enrolledIn(107), ['subscribed']);
            const id2 = await order(ORG, 'nosteps2@example.com');
            assert.strictEqual(await enrolShopBuyer(db, { organisationId: ORG, email: 'nosteps2@example.com', orderId: id2, audience: { result: 'already', contactId: 108, status: 'subscribed' } }), 'none');
            await sql.unsafe(`UPDATE newsletter_sequence_steps SET is_enabled = true WHERE sequence_id = ${firstOrderFlow}`);
        });
        await check('the database: first_order allowed, an unknown trigger refused, only ONE first-order flow on', async () => {
            await flow(ORG, 'first_order', false, 'Second, off');   // a second one switched OFF is fine
            await assert.rejects(flow(ORG, 'first_order', true, 'Second, on'), (e: { code?: string }) => e.code === '23505');
            await assert.rejects(flow(ORG, 'bogus', false, 'Nope'), (e: { code?: string }) => e.code === '23514');
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
