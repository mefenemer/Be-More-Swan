// tests/shop-buyer-audience-db.test.ts
// Buyers who say yes join the Audience — on REAL Postgres (online shop Phase 2, slice 4a; feature request #35).
// src/utils/shop-buyer-audience.ts addShopBuyerToAudience: whenever the tick leaves someone SUBSCRIBED there is a
// consent record with the box's exact words (review #901: a pending double-opt-in contact was subscribed with no
// record and the wrong basis); a refusal is never lifted; the tag lands; a new contact, a pending one, an
// already-subscribed one and an unsubscribed one each come out right.
//
// HOW. Copies of the four Audience tables (`LIKE … INCLUDING ALL`: real columns, defaults, unique indexes — the
// upsert needs the (organisation_id, email) one; no foreign keys) in a throwaway schema, search_path set to it.
//
// ⚠️ Runs ONLY against a database on localhost (CI's rls job) — never staging/prod.
//
// Run:  npx tsx tests/shop-buyer-audience-db.test.ts

import assert from 'node:assert';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { closeDbPools } from '../db/client';
import { addShopBuyerToAudience } from '../src/utils/shop-buyer-audience';

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
    console.log('Shop buyers → Audience: consent always recorded, refusals never lifted (real Postgres)');
    const url = process.env.NETLIFY_DATABASE_URL;
    if (!isLocal(url)) { console.log('  ⊘ skipped — no LOCAL database (CI rls job only; never staging/prod)'); return; }

    const schema = `shop_buyer_audience_test_${Date.now()}`;
    const sql = postgres(url, { max: 1 });
    try {
        await sql.unsafe(`CREATE SCHEMA ${schema}`);
        for (const t of ['audience_contacts', 'audience_consent_events', 'audience_segments', 'audience_contact_segments']) {
            await sql.unsafe(`CREATE TABLE ${schema}.${t} (LIKE public.${t} INCLUDING ALL)`);
        }
        await sql.unsafe(`SET search_path TO ${schema}`);
        const db = drizzle({ client: sql }) as never;
        const ORG = 5;
        const WORDS = 'Send me news and offers from Kudzu Candles by email. You can unsubscribe at any time.';
        const add = (email: string, orderId: number) => addShopBuyerToAudience(db, { organisationId: ORG, email, name: 'Sam Jones', orderId, words: WORDS });
        const contact = async (email: string) => (await sql.unsafe(`SELECT id, status, consent_basis FROM audience_contacts WHERE organisation_id = ${ORG} AND email = $1`, [email]))[0];
        const events = async (id: number) => sql.unsafe(`SELECT event, evidence FROM audience_consent_events WHERE contact_id = ${id} ORDER BY id`);
        const tagged = async (id: number) => (await sql.unsafe(`SELECT s.name FROM audience_contact_segments cs JOIN audience_segments s ON s.id = cs.segment_id WHERE cs.contact_id = ${id}`)).map((r) => r.name);
        const seed = async (email: string, status: string, basis: string | null) => sql.unsafe(
            `INSERT INTO audience_contacts (organisation_id, email, status, source, consent_basis) VALUES (${ORG}, $1, $2, 'web_form', $3)`, [email, status, basis]);

        await check('new buyer: added, single opt-in, consent with the exact words, tagged "Shop buyer"', async () => {
            const r = await add('new@example.com', 1);
            assert.strictEqual(r.result, 'added');
            const c = await contact('new@example.com');
            assert.deepStrictEqual([c.status, c.consent_basis], ['subscribed', 'single_opt_in']);
            const ev = await events(c.id);
            assert.strictEqual(ev.length, 1);
            assert.ok(ev[0].evidence.includes(`Ticked "${WORDS}" (unticked by default)`) && ev[0].evidence.includes('order 1'));
            assert.deepStrictEqual(await tagged(c.id), ['Shop buyer']);
        });
        await check('review #901: a PENDING (unconfirmed double opt-in) contact this tick subscribes → "added", basis single opt-in, consent recorded', async () => {
            await seed('pending@example.com', 'pending', 'double_opt_in');
            const r = await add('pending@example.com', 2);
            assert.strictEqual(r.result, 'added');
            const c = await contact('pending@example.com');
            assert.deepStrictEqual([c.status, c.consent_basis], ['subscribed', 'single_opt_in']);
            assert.strictEqual((await events(c.id)).length, 1);
        });
        await check('already subscribed (soft opt-in): stays as it was, but this explicit opt-in is recorded too', async () => {
            await seed('soft@example.com', 'subscribed', 'soft_opt_in');
            const r = await add('soft@example.com', 3);
            assert.deepStrictEqual(r.result === 'already' && r.status, 'subscribed');
            const c = await contact('soft@example.com');
            assert.strictEqual(c.consent_basis, 'soft_opt_in');
            assert.strictEqual((await events(c.id)).length, 1);
            assert.deepStrictEqual(await tagged(c.id), ['Shop buyer']);
        });
        await check('unsubscribed or bounced: never lifted, no consent record, no tag', async () => {
            await seed('stop@example.com', 'unsubscribed', 'double_opt_in');
            await seed('bounce@example.com', 'bounced', 'single_opt_in');
            for (const [email, status] of [['stop@example.com', 'unsubscribed'], ['bounce@example.com', 'bounced']]) {
                const r = await add(email, 4);
                assert.deepStrictEqual(r.result === 'already' && r.status, status);
                const c = await contact(email);
                assert.strictEqual(c.status, status);
                assert.strictEqual((await events(c.id)).length, 0);
                assert.deepStrictEqual(await tagged(c.id), []);
            }
        });
        await check('no usable email → nothing written', async () => {
            assert.deepStrictEqual(await addShopBuyerToAudience(db, { organisationId: ORG, email: null, name: null, orderId: 5 }), { result: 'no_email' });
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
