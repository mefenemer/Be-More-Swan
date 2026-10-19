// tests/partner-ops-db.test.ts
// The Partner Ops read queries on REAL Postgres — src/utils/partner-ops.ts (the Partners screen's
// list, and the chat's top referrers / pre-payout audit / recruitment).
//
// WHY A DATABASE TEST. The pre-payout audit is the admin's last look before paying people outside
// the company: a self-referral sign that never fires (a wrong join, a card on the wrong workspace) is
// silent. Aggregates with FILTER, correlated subqueries and make_interval windows can only be proven
// against Postgres.
//
// HOW. Copies of the tables it reads (`LIKE … INCLUDING ALL`, no foreign keys) in a throwaway
// schema, one connection, search_path set to it. Same shape as tests/partner-ledger-db.test.ts.
//
// ⚠️ Runs ONLY against a database on localhost (CI's rls job). db/client loads .env, and locally that
// is STAGING — this test must never create schemas there.
//
// Run:  npx tsx tests/partner-ops-db.test.ts

import assert from 'node:assert';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { listPartnersWithNumbers, partnerDetail, payoutAudit, recruitmentCandidates, topReferrers } from '../src/utils/partner-ops';

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

const TABLES = ['users', 'organisations', 'user_organisations', 'plans', 'ai_usage_log', 'user_referrals', 'partners', 'partner_referrals', 'partner_commissions'];

async function main() {
    console.log('Partner Ops read queries (real Postgres)');
    const url = process.env.NETLIFY_DATABASE_URL;
    if (!isLocal(url)) { console.log('  ⊘ skipped — no LOCAL database (CI rls job only; never staging/prod)'); return; }

    const schema = `partner_ops_test_${Date.now()}`;
    const sql = postgres(url, { max: 1 });
    try {
        await sql.unsafe(`CREATE SCHEMA ${schema}`);
        for (const t of TABLES) await sql.unsafe(`CREATE TABLE ${schema}.${t} (LIKE public.${t} INCLUDING ALL)`);
        await sql.unsafe(`SET search_path TO ${schema}`);
        const db = drizzle({ client: sql }) as never;

        // Workspaces: 1 the partner's, 2 a customer on the SAME card, 3 a customer on another card,
        // 4 an active paying non-partner, 5 a trial-only user, 6 an admin's.
        await sql.unsafe(`INSERT INTO organisations (id, name, slug, card_fingerprint) VALUES
            (1, 'Acme', 'acme', 'fp_A'), (2, 'Acme Two', 'acme-two', 'fp_A'), (3, 'Carol Co', 'carol', 'fp_C'),
            (4, 'Dana Ltd', 'dana', NULL), (5, 'Eve Trial', 'eve', NULL), (6, 'Staff', 'staff', NULL)`);
        await sql.unsafe(`INSERT INTO users (id, email, first_name, last_name, role, referral_code) VALUES
            (100, 'sam@acme.co.uk', 'Sam', 'Partner', 'user', 'SAM1'), (200, 'bob@acme.co.uk', 'Bob', NULL, 'user', 'BOB1'),
            (201, 'carol@gmail.com', 'Carol', NULL, 'user', 'CAR1'), (300, 'dana@example.org', 'Dana', NULL, 'user', 'DAN1'),
            (301, 'eve@example.org', 'Eve', NULL, 'user', 'EVE1'), (302, 'staff@example.org', 'Staff', NULL, 'super_admin', 'STA1')`);
        await sql.unsafe(`INSERT INTO user_organisations (user_id, organisation_id) VALUES (100,1),(200,2),(201,3),(300,4),(301,5),(302,6)`);
        await sql.unsafe(`INSERT INTO plans (organisation_id, user_id, plan_name, plan_type, status) VALUES
            (1, 100, 'Saver', 'subscription', 'active'), (4, 300, 'Saver', 'subscription', 'active'),
            (5, 301, 'Trial', 'trial', 'active'), (6, 302, 'Saver', 'subscription', 'active')`);
        // AI actions in the last 30 days: Dana 20, Eve 30 (trial only), Staff 40 (admin), Sam 50 (already a partner).
        for (const [user, n] of [[300, 20], [301, 30], [302, 40], [100, 50]]) {
            await sql.unsafe(`INSERT INTO ai_usage_log (user_id, model, input_tokens, output_tokens, created_at)
                              SELECT ${user}, 'claude-haiku-4-5', 1, 1, now() - make_interval(days => g % 20) FROM generate_series(1, ${n}) g`);
        }
        await sql.unsafe(`INSERT INTO ai_usage_log (user_id, model, input_tokens, output_tokens, created_at)
                          SELECT 300, 'claude-haiku-4-5', 1, 1, now() - make_interval(days => 60) FROM generate_series(1, 100)`);   // too old to count

        const [p] = await sql.unsafe(`INSERT INTO partners (user_id, status, payout_method, payout_display, payout_details_confirmed_at) VALUES (100, 'approved', 'paypal', 'PayPal · s***@acme.co.uk', now()) RETURNING id`);
        const refs = await sql.unsafe(`INSERT INTO user_referrals (referrer_id, referred_user_id, referral_code) VALUES (100, 200, 'SAM1'), (100, 201, 'SAM1') RETURNING id, referred_user_id`);
        const refBob = refs.find((r: any) => r.referred_user_id === 200)!.id;
        const refCarol = refs.find((r: any) => r.referred_user_id === 201)!.id;
        const [prBob] = await sql.unsafe(`INSERT INTO partner_referrals (referral_id, partner_id, subscribed_at, rate_bps, duration_months)
                                          VALUES (${refBob}, ${p.id}, now() - make_interval(days => 2), 2500, 12) RETURNING id`);
        const [prCarol] = await sql.unsafe(`INSERT INTO partner_referrals (referral_id, partner_id, subscribed_at, rate_bps, duration_months)
                                            VALUES (${refCarol}, ${p.id}, now() - make_interval(days => 30), 2500, 12) RETURNING id`);
        await sql.unsafe(`INSERT INTO partner_commissions (partner_id, partner_referral_id, kind, stripe_invoice_id, net_amount_pence, rate_bps, commission_pence, status, available_at, created_at) VALUES
            (${p.id}, ${prBob.id},   'invoice', 'in_1', 2900, 2500, 725, 'payable', now(), now() - make_interval(days => 40)),
            (${p.id}, ${prCarol.id}, 'invoice', 'in_2', 2000, 2500, 500, 'payable', now(), now() - make_interval(days => 35)),
            (${p.id}, ${prCarol.id}, 'invoice', 'in_3', 2900, 2500, 725, 'voided',  now(), now() - make_interval(days => 10)),
            (${p.id}, ${prBob.id},   'invoice', 'in_4', 1200, 2500, 300, 'pending', now() + make_interval(days => 20), now() - make_interval(days => 10))`);

        await check('the partner list adds up (screen and chat read the same numbers)', async () => {
            const [row] = await listPartnersWithNumbers(db);
            assert.deepStrictEqual(
                { referrals: row.referrals, paying: row.paying, pending: row.pending_pence, payable: row.payable_pence, paid: row.paid_pence, payout: row.has_payout_details, email: row.email },
                { referrals: 2, paying: 2, pending: 300, payable: 1225, paid: 0, payout: true, email: 'sam@acme.co.uk' });
        });

        await check('top referrers count earned commission in the window, never voided rows', async () => {
            const [row] = await topReferrers(db, 90, 3);
            assert.strictEqual(row.earned_pence, 1525);     // 725 + 500 + 300; the voided 725 is out
            assert.strictEqual(row.new_paying, 2);
            const [recent] = await topReferrers(db, 20, 3);
            assert.strictEqual(recent.earned_pence, 300, 'only in_4 was created in the last 20 days and is not voided');
        });

        await check('the pre-payout audit flags the same-card and same-domain customer, the reversal and the burst', async () => {
            const audit = await payoutAudit(db, 5000);
            assert.strictEqual(audit.totalPayablePence, 1225);
            const [row] = audit.partners;
            assert.deepStrictEqual(
                { payable: row.payable_pence, sameCard: row.same_card_customers, sameDomain: row.same_domain_customers, reversed: row.reversed_90d, burst: row.new_paying_7d, overMin: row.over_minimum },
                { payable: 1225, sameCard: 1, sameDomain: 1, reversed: 1, burst: 1, overMin: false });
        });

        await check('public mail domains never count as "same domain"', async () => {
            await sql.unsafe(`UPDATE users SET email = 'sam@gmail.com' WHERE id = 100`);
            await sql.unsafe(`UPDATE users SET email = 'bob@gmail.com' WHERE id = 200`);
            const [row] = (await payoutAudit(db, 5000)).partners;
            assert.strictEqual(row.same_domain_customers, 0);
            await sql.unsafe(`UPDATE users SET email = 'sam@acme.co.uk' WHERE id = 100`);
            await sql.unsafe(`UPDATE users SET email = 'bob@acme.co.uk' WHERE id = 200`);
        });

        await check('recruitment: active paying customers only — not partners, trials, admins or old activity', async () => {
            const list = await recruitmentCandidates(db, 30, 15, 10);
            assert.deepStrictEqual(list.map((r) => [r.email, r.ai_actions]), [['dana@example.org', 20]]);
            assert.deepStrictEqual((await recruitmentCandidates(db, 30, 25, 10)).length, 0, 'Dana has 20 recent actions, under 25');
        });

        await check("one partner's detail lists who they referred and their ledger", async () => {
            const d = await partnerDetail(db, p.id);
            assert.deepStrictEqual(d.referrals.map((r) => r.customer_email).sort(), ['bob@acme.co.uk', 'carol@gmail.com']);
            assert.strictEqual(d.commissions.length, 4);
        });
    } finally {
        await sql.unsafe(`SET search_path TO public`).catch(() => {});
        await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
        await sql.end();
    }
    console.log(`\n${passed} passed`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
