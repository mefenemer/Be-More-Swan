// tests/partner-ledger-db.test.ts
// The partner commission ledger on REAL Postgres — src/utils/partner-ledger.ts
// (docs/affiliate-partner-programme-plan.md §4.3).
//
// WHY A DATABASE TEST. This is money owed to people outside the company. The rate lock is a
// conditional UPDATE, a redelivered webhook is stopped by a PARTIAL unique index, and refunds
// recompute from Stripe's running total — all of it only provable against Postgres.
//
// HOW. Copies of the tables it touches (`LIKE … INCLUDING ALL`: real columns, defaults, checks,
// unique keys; no foreign keys) in a throwaway schema, on ONE connection with search_path set to it.
// Same shape as tests/task-metering-db.test.ts.
//
// ⚠️ Runs ONLY against a database on localhost (CI's rls job). db/client loads .env, and locally that
// is STAGING — this test must never create schemas there.
//
// Run:  npx tsx tests/partner-ledger-db.test.ts

import assert from 'node:assert';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import {
    isPartnerReferrer, recordPartnerPayment, releaseDueCommissions, reversePartnerCommission,
} from '../src/utils/partner-ledger';
import { qualifyPendingReferral } from '../src/utils/referral-offer';

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

const TABLES = ['users', 'user_referrals', 'partners', 'partner_rate_periods', 'partner_referrals', 'partner_programme_settings', 'partner_commissions'];
const d = (s: string) => new Date(`${s}T12:00:00Z`);
const DAY = 24 * 60 * 60 * 1000;

async function main() {
    console.log('Partner commission ledger (real Postgres)');
    const url = process.env.NETLIFY_DATABASE_URL;
    if (!isLocal(url)) { console.log('  ⊘ skipped — no LOCAL database (CI rls job only; never staging/prod)'); return; }

    const schema = `partner_ledger_test_${Date.now()}`;
    const sql = postgres(url, { max: 1 });
    try {
        await sql.unsafe(`CREATE SCHEMA ${schema}`);
        for (const t of TABLES) await sql.unsafe(`CREATE TABLE ${schema}.${t} (LIKE public.${t} INCLUDING ALL)`);
        await sql.unsafe(`SET search_path TO ${schema}`);
        const db = drizzle({ client: sql }) as never;

        await sql.unsafe(`INSERT INTO partner_programme_settings (id, holding_days) VALUES (1, 30)`);
        await sql.unsafe(`INSERT INTO partner_rate_periods (partner_id, rate_bps, duration_months, starts_at, ends_at)
                          VALUES (NULL, 2500, 12, '2026-10-18', '2026-12-01'), (NULL, 2000, 12, '2026-12-01', NULL)`);
        // Users: 100 approved partner, 101 suspended partner, 102 ordinary customer.
        const [p1] = await sql.unsafe(`INSERT INTO partners (user_id, status) VALUES (100, 'approved') RETURNING id`);
        await sql.unsafe(`INSERT INTO partners (user_id, status) VALUES (101, 'suspended')`);
        // Referred customers: 200, 201 (by partner 100), 202 (by suspended 101), 203 (by customer 102).
        await sql.unsafe(`INSERT INTO user_referrals (referrer_id, referred_user_id, referral_code) VALUES
                          (100, 200, 'p1'), (100, 201, 'p1'), (101, 202, 'p2'), (102, 203, 'c1'), (100, 204, 'p1')`);

        const commissions = (ref: string) => sql.unsafe(`SELECT * FROM partner_commissions WHERE stripe_invoice_id = '${ref}' ORDER BY id`);
        const pay = (userId: number, ref: string, net: number, at: Date, pi: string | null = `pi_${ref}`) =>
            recordPartnerPayment(db, { userId, paymentRef: ref, paymentIntentId: pi, netAmountPence: net, currency: 'gbp', paidAt: at });

        await check('an ordinary customer\'s referral earns no commission', async () => {
            assert.deepStrictEqual(await pay(203, 'in_c1', 2900, d('2026-11-01')), { recorded: false, reason: 'not_a_partner_referral' });
            assert.strictEqual((await commissions('in_c1')).length, 0);
        });

        await check('a suspended partner earns nothing, and is still on the partner track (no token either)', async () => {
            assert.strictEqual((await pay(202, 'in_s1', 2900, d('2026-11-01'))).recorded, false);
            assert.strictEqual(await isPartnerReferrer(db, 101), true);
            assert.strictEqual(await isPartnerReferrer(db, 102), false);
        });

        await check('first payment locks the rate of its period and writes a pending commission', async () => {
            const out = await pay(200, 'in_a1', 2900, d('2026-11-05'));
            assert.deepStrictEqual(out, { recorded: true, commissionPence: 725, partnerId: p1.id });
            const [row] = await commissions('in_a1');
            assert.strictEqual(row.status, 'pending');
            assert.strictEqual(row.rate_bps, 2500);
            assert.strictEqual(new Date(row.available_at).getTime(), d('2026-11-05').getTime() + 30 * DAY);
            const [pr] = await sql.unsafe(`SELECT * FROM partner_referrals WHERE partner_id = ${p1.id} AND rate_bps IS NOT NULL ORDER BY id LIMIT 1`);
            assert.strictEqual(pr.rate_bps, 2500);
            assert.strictEqual(pr.duration_months, 12);
        });

        await check('a redelivered payment is a no-op', async () => {
            assert.deepStrictEqual(await pay(200, 'in_a1', 2900, d('2026-11-05')), { recorded: false, reason: 'duplicate' });
            assert.strictEqual((await commissions('in_a1')).length, 1);
        });

        await check('renewals keep the locked rate after the programme rate drops', async () => {
            const out = await pay(200, 'in_a2', 2900, d('2026-12-05'));
            assert.ok(out.recorded && out.commissionPence === 725, JSON.stringify(out));
        });

        await check('a customer who first pays in the new period gets the new rate', async () => {
            const out = await pay(201, 'in_b1', 2900, d('2026-12-10'));
            assert.ok(out.recorded && out.commissionPence === 580, JSON.stringify(out));
        });

        await check("a partner's own period beats the programme rate", async () => {
            await sql.unsafe(`INSERT INTO partner_rate_periods (partner_id, rate_bps, duration_months, starts_at, ends_at)
                              VALUES (${p1.id}, 3000, NULL, '2027-01-01', '2027-02-01')`);
            const out = await pay(204, 'in_v1', 2900, d('2027-01-15'));
            assert.ok(out.recorded && out.commissionPence === 870, JSON.stringify(out));
            const out2 = await pay(204, 'in_v2', 2900, d('2032-01-15'));
            assert.ok(out2.recorded, 'lifetime duration from the partner period keeps earning');
        });

        await check('nothing is earned once the 12-month window has passed', async () => {
            assert.deepStrictEqual(await pay(200, 'in_a13', 2900, d('2027-11-05')), { recorded: false, reason: 'outside_window' });
            assert.ok((await pay(200, 'in_a12', 2900, d('2027-10-05'))).recorded, 'month 12 still earns');
        });

        await check('a partial refund reduces an unpaid commission; a full refund voids it; redelivery changes nothing', async () => {
            await reversePartnerCommission(db, { paymentIntentId: 'pi_in_a2', amountRefundedPence: 900, kind: 'refund' });
            assert.strictEqual((await commissions('in_a2'))[0].commission_pence, 500);   // 25% of 2000
            await reversePartnerCommission(db, { paymentIntentId: 'pi_in_a2', amountRefundedPence: 900, kind: 'refund' });
            assert.strictEqual((await commissions('in_a2'))[0].commission_pence, 500);
            await reversePartnerCommission(db, { paymentIntentId: 'pi_in_a2', amountRefundedPence: 2900, kind: 'refund' });
            const [row] = await commissions('in_a2');
            assert.strictEqual(row.status, 'voided');
            assert.strictEqual(row.void_reason, 'Payment refunded');
        });

        await check('a refund is matched by invoice when the payment was stored without a PaymentIntent', async () => {
            await pay(201, 'in_b2', 2900, d('2027-01-10'), null);
            await reversePartnerCommission(db, { paymentIntentId: 'pi_unknown', invoiceId: 'in_b2', amountRefundedPence: 2900, kind: 'refund' });
            assert.strictEqual((await commissions('in_b2'))[0].status, 'voided');
        });

        await check('refunding an already-paid commission claws it back once, as a negative adjustment', async () => {
            await sql.unsafe(`UPDATE partner_commissions SET status = 'paid', paid_at = now() WHERE stripe_invoice_id = 'in_b1'`);
            await reversePartnerCommission(db, { paymentIntentId: 'pi_in_b1', amountRefundedPence: 1450, kind: 'refund' });
            await reversePartnerCommission(db, { paymentIntentId: 'pi_in_b1', amountRefundedPence: 1450, kind: 'refund' });
            let rows = await commissions('in_b1');
            assert.deepStrictEqual(rows.map((r: any) => [r.kind, r.commission_pence]), [['invoice', 580], ['adjustment', -290]]);
            await reversePartnerCommission(db, { paymentIntentId: 'pi_in_b1', amountRefundedPence: 2900, kind: 'refund' });
            rows = await commissions('in_b1');
            assert.deepStrictEqual(rows.map((r: any) => [r.kind, r.commission_pence]), [['invoice', 580], ['adjustment', -290], ['adjustment', -290]]);
        });

        await check('a dispute voids an unpaid commission', async () => {
            await reversePartnerCommission(db, { paymentIntentId: 'pi_in_v1', amountRefundedPence: 0, kind: 'dispute' });
            const [row] = await commissions('in_v1');
            assert.strictEqual(row.status, 'voided');
            assert.strictEqual(row.void_reason, 'Payment disputed');
        });

        await check('the nightly sweep releases only commissions past their holding period', async () => {
            const { released } = await releaseDueCommissions(db, d('2026-12-06'));   // in_a1 due 2026-12-05
            assert.strictEqual(released, 1);
            assert.strictEqual((await commissions('in_a1'))[0].status, 'payable');
            assert.strictEqual((await commissions('in_a12'))[0].status, 'pending');
            assert.strictEqual((await releaseDueCommissions(db, d('2026-12-06'))).released, 0, 'idempotent');
        });

        await check("a partner's referral qualifies as 'partner', never as a token", async () => {
            await sql.unsafe(`INSERT INTO user_referrals (referrer_id, referred_user_id, referral_code) VALUES (100, 205, 'p1')`);
            assert.strictEqual(await qualifyPendingReferral(db, 205), false);
            const [row] = await sql.unsafe(`SELECT status, qualified_at FROM user_referrals WHERE referred_user_id = 205`);
            assert.strictEqual(row.status, 'partner');
            assert.ok(row.qualified_at);
        });
    } finally {
        await sql.unsafe(`SET search_path TO public`).catch(() => {});
        await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
        await sql.end();
    }
    console.log(`\n${passed} passed`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
