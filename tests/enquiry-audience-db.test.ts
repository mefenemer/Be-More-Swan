// tests/enquiry-audience-db.test.ts
// Website enquirers who agree join the Audience — on REAL Postgres. src/utils/enquiry-audience.ts
// addEnquirerToAudience: whenever the tick (or the owner's "they agreed") leaves someone SUBSCRIBED there is a consent
// record (the bug: a pending double-opt-in contact was subscribed with no record and basis double_opt_in — the same
// flaw review #901 found and fixed in shop-buyer-audience.ts); a refusal is never lifted; the tag lands after the
// record; new, pending, soft-opt-in, unsubscribed, bounced, owner-added and no-email each come out right.
//
// HOW. Copies of the four Audience tables (`LIKE … INCLUDING ALL`: real columns, defaults, unique indexes — the
// upsert needs the (organisation_id, email) one; no foreign keys) in a throwaway schema, search_path set to it.
//
// ⚠️ Runs ONLY against a database on localhost (CI's rls job) — never staging/prod.
//
// Run:  npx tsx tests/enquiry-audience-db.test.ts

import assert from 'node:assert';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { closeDbPools } from '../db/client';
import { addEnquirerToAudience } from '../src/utils/enquiry-audience';

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
    console.log('Website enquirers → Audience: consent always recorded, refusals never lifted (real Postgres)');
    const url = process.env.NETLIFY_DATABASE_URL;
    if (!isLocal(url)) { console.log('  ⊘ skipped — no LOCAL database (CI rls job only; never staging/prod)'); return; }

    const schema = `enquiry_audience_test_${Date.now()}`;
    const sql = postgres(url, { max: 1 });
    try {
        await sql.unsafe(`CREATE SCHEMA ${schema}`);
        for (const t of ['audience_contacts', 'audience_consent_events', 'audience_segments', 'audience_contact_segments']) {
            await sql.unsafe(`CREATE TABLE ${schema}.${t} (LIKE public.${t} INCLUDING ALL)`);
        }
        await sql.unsafe(`SET search_path TO ${schema}`);
        const db = drizzle({ client: sql }) as never;
        const ORG = 5;
        const add = (email: string, enquiryId: number, by: 'form' | { userId: number } = 'form') =>
            addEnquirerToAudience(db, { organisationId: ORG, email, name: 'Sam Jones', enquiryId, by, sourceUrl: 'https://example.com/contact' });
        const contact = async (email: string) => (await sql.unsafe(`SELECT id, status, consent_basis FROM audience_contacts WHERE organisation_id = ${ORG} AND email = $1`, [email]))[0];
        const events = async (id: number) => sql.unsafe(`SELECT event, channel, evidence FROM audience_consent_events WHERE contact_id = ${id} ORDER BY id`);
        const tagged = async (id: number) => (await sql.unsafe(`SELECT s.name FROM audience_contact_segments cs JOIN audience_segments s ON s.id = cs.segment_id WHERE cs.contact_id = ${id}`)).map((r) => r.name);
        const seed = async (email: string, status: string, basis: string | null) => sql.unsafe(
            `INSERT INTO audience_contacts (organisation_id, email, status, source, consent_basis) VALUES (${ORG}, $1, $2, 'web_form', $3)`, [email, status, basis]);

        await check('new enquirer who ticked: added, single opt-in, one "confirmed" record, tagged "Website enquiry"', async () => {
            const r = await add('new@example.com', 1);
            assert.strictEqual(r.result, 'added');
            const c = await contact('new@example.com');
            assert.deepStrictEqual([c.status, c.consent_basis], ['subscribed', 'single_opt_in']);
            const ev = await events(c.id);
            assert.deepStrictEqual(ev.map((e) => [e.event, e.channel]), [['confirmed', 'site']]);
            assert.ok(ev[0].evidence.includes('Ticked "Send me news and offers by email"') && ev[0].evidence.includes('enquiry 1'));
            assert.deepStrictEqual(await tagged(c.id), ['Website enquiry']);
        });
        await check('the bug: a PENDING (unconfirmed double opt-in) contact this tick subscribes → "added", basis single opt-in, consent recorded', async () => {
            await seed('pending@example.com', 'pending', 'double_opt_in');
            const r = await add('pending@example.com', 2);
            assert.strictEqual(r.result, 'added');
            const c = await contact('pending@example.com');
            assert.deepStrictEqual([c.status, c.consent_basis], ['subscribed', 'single_opt_in']);
            assert.deepStrictEqual((await events(c.id)).map((e) => e.event), ['confirmed']);
            assert.deepStrictEqual(await tagged(c.id), ['Website enquiry']);
        });
        await check('already subscribed (soft opt-in): basis kept, "already", but this explicit opt-in is recorded too', async () => {
            await seed('soft@example.com', 'subscribed', 'soft_opt_in');
            const r = await add('soft@example.com', 3);
            assert.deepStrictEqual(r.result === 'already' && r.status, 'subscribed');
            const c = await contact('soft@example.com');
            assert.deepStrictEqual([c.status, c.consent_basis], ['subscribed', 'soft_opt_in']);
            assert.deepStrictEqual((await events(c.id)).map((e) => e.event), ['confirmed']);
            assert.deepStrictEqual(await tagged(c.id), ['Website enquiry']);
        });
        await check('unsubscribed or bounced: never lifted, no consent record, no tag — by the form or by the owner', async () => {
            await seed('stop@example.com', 'unsubscribed', 'double_opt_in');
            await seed('bounce@example.com', 'bounced', 'single_opt_in');
            for (const [email, status] of [['stop@example.com', 'unsubscribed'], ['bounce@example.com', 'bounced']]) {
                for (const by of ['form', { userId: 9 }] as const) {
                    const r = await add(email, 4, by);
                    assert.deepStrictEqual(r.result === 'already' && r.status, status);
                }
                const c = await contact(email);
                assert.strictEqual(c.status, status);
                assert.strictEqual((await events(c.id)).length, 0);
                assert.deepStrictEqual(await tagged(c.id), []);
            }
        });
        await check('owner-added: new → manual entry + "manual_added" record; pending → manual entry, recorded', async () => {
            const r = await add('owner-new@example.com', 5, { userId: 9 });
            assert.strictEqual(r.result, 'added');
            const c = await contact('owner-new@example.com');
            assert.deepStrictEqual([c.status, c.consent_basis], ['subscribed', 'manual_entry']);
            const ev = await events(c.id);
            assert.deepStrictEqual(ev.map((e) => [e.event, e.channel]), [['manual_added', 'admin']]);
            assert.ok(ev[0].evidence.includes('by user 9') && ev[0].evidence.includes('enquiry 5'));
            assert.deepStrictEqual(await tagged(c.id), ['Website enquiry']);

            await seed('owner-pending@example.com', 'pending', 'double_opt_in');
            assert.strictEqual((await add('owner-pending@example.com', 6, { userId: 9 })).result, 'added');
            const p = await contact('owner-pending@example.com');
            assert.deepStrictEqual([p.status, p.consent_basis], ['subscribed', 'manual_entry']);
            assert.deepStrictEqual((await events(p.id)).map((e) => e.event), ['manual_added']);
        });
        await check('the basis update is scoped to the organisation: the same address in another workspace is untouched', async () => {
            await sql.unsafe(`INSERT INTO audience_contacts (organisation_id, email, status, source, consent_basis) VALUES (6, 'shared@example.com', 'pending', 'web_form', 'double_opt_in')`);
            await seed('shared@example.com', 'pending', 'double_opt_in');
            assert.strictEqual((await add('shared@example.com', 7)).result, 'added');
            const [other] = await sql.unsafe(`SELECT status, consent_basis FROM audience_contacts WHERE organisation_id = 6 AND email = 'shared@example.com'`);
            assert.deepStrictEqual([other.status, other.consent_basis], ['pending', 'double_opt_in']);
        });
        await check('no usable email → nothing written', async () => {
            const before = (await sql.unsafe(`SELECT count(*)::int AS n FROM audience_contacts`))[0].n;
            assert.deepStrictEqual(await add('not-an-email', 8), { result: 'no_email' });
            assert.strictEqual((await sql.unsafe(`SELECT count(*)::int AS n FROM audience_contacts`))[0].n, before);
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
