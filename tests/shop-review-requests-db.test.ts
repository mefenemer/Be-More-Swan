// tests/shop-review-requests-db.test.ts
// Review requests after SHOP ORDERS go only from the owner's own address (online shop Phase 2, slice 7; owner Q1
// 2026-11-26; src/utils/review-requests.ts), on REAL Postgres: a workspace with a route is asked via that route; one
// without is NOT claimed (no row) and is asked once a route exists; workspaces waiting for a route never use up the
// batch; "don't ask me again" still wins.
//
// HOW. Copies of the tables it touches (`LIKE … INCLUDING ALL`; no foreign keys) in a throwaway schema, search_path set
// to it. The route and the sender are stubbed.
//
// ⚠️ Runs ONLY against a database on localhost (CI's rls job) — never staging/prod.
//
// Run:  npx tsx tests/shop-review-requests-db.test.ts

import assert from 'node:assert';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { closeDbPools } from '../db/client';
import { orderReviewRequestsBlocked, sendDueReviewRequests } from '../src/utils/review-requests';

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
    console.log('Shop-order review requests: own address only, waiting without one (real Postgres)');
    const url = process.env.NETLIFY_DATABASE_URL;
    if (!isLocal(url)) { console.log('  ⊘ skipped — no LOCAL database (CI rls job only; never staging/prod)'); return; }
    process.env.JWT_SECRET ||= 'test-only-secret';

    const schema = `shop_review_requests_test_${Date.now()}`;
    const sql = postgres(url, { max: 1 });
    try {
        await sql.unsafe(`CREATE SCHEMA ${schema}`);
        for (const t of ['organisations', 'sites', 'site_orders', 'review_settings', 'review_requests', 'review_opt_outs', 'bookings', 'org_products', 'users', 'ai_assistants']) {
            await sql.unsafe(`CREATE TABLE ${schema}.${t} (LIKE public.${t} INCLUDING ALL)`);
        }
        await sql.unsafe(`SET search_path TO ${schema}`);
        const db = drizzle({ client: sql }) as never;
        const A = 21, B = 22;
        for (const [org, slug] of [[A, 'alpha'], [B, 'beta']] as const) {
            await sql.unsafe(`INSERT INTO organisations (id, name, slug) VALUES (${org}, 'Shop ${slug}', 'rr-${slug}')`);
            await sql.unsafe(`INSERT INTO sites (id, organisation_id, ai_assistant_id, slug, draft, status) VALUES (${org * 10}, ${org}, 1, '${slug}', '{}'::jsonb, 'published')`);
            await sql.unsafe(`INSERT INTO review_settings (organisation_id, ask_after_orders, order_delay_days, enabled_at) VALUES (${org}, true, 7, now() - interval '30 days')`);
        }
        let n = 0;
        const order = async (org: number, email: string) => Number((await sql.unsafe(
            `INSERT INTO site_orders (site_id, organisation_id, stripe_account_id, checkout_session_id, item_name, quantity, amount_total, currency, customer_email, customer_name, status, created_at)
             VALUES (${org * 10}, ${org}, 'acct_x', 'cs_rr_${++n}', 'Mug', 1, 800, 'gbp', $1, 'Sam Jones', 'paid', now() - interval '10 days') RETURNING id`, [email]))[0].id);
        const sent: Array<{ org: number; to: string; text: string }> = [];
        const deliver = (async (_db: unknown, _route: unknown, org: number, m: { to: string; text: string }) => { sent.push({ org, to: m.to, text: m.text }); return null; }) as never;
        const ownRoute = { route: { provider: 'gmail' as const, from: null, replyTo: null, engagementTracked: false } };
        let bHasRoute = false;
        const route = async (_db: unknown, orgId: number) => (orgId === A || (orgId === B && bHasRoute) ? ownRoute : { error: 'There is no way to send this yet.' });
        const rows = async (org: number) => sql.unsafe(`SELECT order_id, sent_at, skipped_reason FROM review_requests WHERE organisation_id = ${org} ORDER BY id`);

        const a1 = await order(A, 'sam@alpha.example');
        const b1 = await order(B, 'kim@beta.example');

        await check('with a route: asked via the owner\'s own route (never "via Be More Swan"); without one: not claimed at all', async () => {
            const count = await sendDueReviewRequests(db, new Date(), { route: route as never, deliver });
            assert.strictEqual(count, 1);
            assert.deepStrictEqual(sent.map((s) => [s.org, s.to]), [[A, 'sam@alpha.example']]);
            assert.ok(sent[0].text.includes('Leave a review: ') && sent[0].text.includes("Don't ask me for reviews again: "), 'a plain-text part for the mailbox send');
            const ra = await rows(A);
            assert.strictEqual(ra.length, 1);
            assert.ok(ra[0].sent_at && Number(ra[0].order_id) === a1);
            assert.strictEqual((await rows(B)).length, 0, 'no row: it stays due');
        });
        await check('the Shop tab line: blocked for the workspace with no route, nothing for the one with a route', async () => {
            assert.ok(/none can be sent yet: they go only from your own address/.test(String(await orderReviewRequestsBlocked(db, B, route as never))));
            assert.strictEqual(await orderReviewRequestsBlocked(db, A, route as never), null);
        });
        await check('once the owner connects a route, the waiting order is asked about on the next run — once', async () => {
            bHasRoute = true;
            assert.strictEqual(await sendDueReviewRequests(db, new Date(), { route: route as never, deliver }), 1);
            assert.deepStrictEqual(sent.map((s) => s.to), ['sam@alpha.example', 'kim@beta.example']);
            assert.ok(Number((await rows(B))[0].order_id) === b1);
            assert.strictEqual(await sendDueReviewRequests(db, new Date(), { route: route as never, deliver }), 0, 'never twice');
        });
        await check('workspaces still waiting for a route never use up the batch', async () => {
            bHasRoute = false;
            for (let i = 0; i < 205; i++) await order(B, `b${i}@beta.example`);
            const a2 = await order(A, 'new@alpha.example');
            assert.strictEqual(await sendDueReviewRequests(db, new Date(), { route: route as never, deliver }), 1);
            assert.ok((await rows(A)).some((r) => Number(r.order_id) === a2));
        });
        await check('"don\'t ask me again" still wins (claimed, skipped, not sent)', async () => {
            await sql.unsafe(`INSERT INTO review_opt_outs (organisation_id, email_key) VALUES (${A}, 'stop@alpha.example')`);
            await order(A, 'stop@alpha.example');
            const before = sent.length;
            await sendDueReviewRequests(db, new Date(), { route: route as never, deliver });
            assert.strictEqual(sent.length, before);
            assert.ok((await rows(A)).some((r) => r.skipped_reason === 'opted_out'));
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
