// tests/partner-codes-db.test.ts
// Partner codes on REAL Postgres — src/utils/invite-codes.ts and how the ledger and the friend offer
// see a customer who came in on one.
//
// WHY A DATABASE TEST. Codes must be unique case-insensitively across BOTH referral codes and partner
// codes; a late code must obey the friend-offer rules; and a partner-code customer must earn the
// partner commission and be recorded as such. Only Postgres proves the indexes and joins.
//
// ⚠️ Runs ONLY against a database on localhost (CI's rls job). db/client loads .env, and locally that
// is STAGING — this test must never create schemas there.
//
// Run:  npx tsx tests/partner-codes-db.test.ts

import assert from 'node:assert';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { claimLateReferral, resolveInviteCode, setPartnerCode } from '../src/utils/invite-codes';
import { findReferralOffer } from '../src/utils/referral-offer';
import { recordPartnerPayment } from '../src/utils/partner-ledger';

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
const TABLES = ['users', 'partners', 'plans', 'user_referrals', 'partner_referrals', 'partner_rate_periods', 'partner_programme_settings', 'partner_commissions'];

async function main() {
    console.log('Partner codes (real Postgres)');
    const url = process.env.NETLIFY_DATABASE_URL;
    if (!isLocal(url)) { console.log('  ⊘ skipped — no LOCAL database (CI rls job only; never staging/prod)'); return; }
    const schema = `partner_codes_test_${Date.now()}`;
    const sql = postgres(url, { max: 1 });
    try {
        await sql.unsafe(`CREATE SCHEMA ${schema}`);
        for (const t of TABLES) await sql.unsafe(`CREATE TABLE ${schema}.${t} (LIKE public.${t} INCLUDING ALL)`);
        await sql.unsafe(`SET search_path TO ${schema}`);
        const db = drizzle({ client: sql }) as never;
        await sql.unsafe(`INSERT INTO users (id, email, first_name, role, referral_code) VALUES
            (1, 'sam@example.com', 'Sam', 'user', 'SAMLINK1'), (2, 'sue@example.com', 'Sue', 'user', 'SUELINK2'),
            (10, 'new@example.com', 'New', 'user', 'NEWCUST1'), (11, 'paid@example.com', 'Paid', 'user', 'PAIDCUS1'), (12, 'cust@example.com', 'Cust', 'user', 'CUSTONE1')`);
        await sql.unsafe(`INSERT INTO partners (id, user_id, status) VALUES (1, 1, 'approved'), (2, 2, 'suspended')`);
        await sql.unsafe(`INSERT INTO partner_programme_settings (id) VALUES (1)`);
        await sql.unsafe(`INSERT INTO partner_rate_periods (partner_id, rate_bps, duration_months, starts_at) VALUES (NULL, 2500, 12, '2026-01-01')`);
        await sql.unsafe(`INSERT INTO plans (organisation_id, user_id, plan_name, plan_type, status) VALUES (11, 11, 'Saver', 'subscription', 'active'), (10, 10, 'Trial', 'trial', 'active')`);

        await check('codes are unique case-insensitively across partner codes AND referral codes', async () => {
            assert.deepStrictEqual(await setPartnerCode(db, 1, 'samswan'), { ok: true, code: 'SAMSWAN' });
            assert.match((await setPartnerCode(db, 2, 'SamSwan') as any).error, /already in use/);
            assert.match((await setPartnerCode(db, 2, 'samlink1') as any).error, /already in use/, 'cannot shadow someone\'s link code');
            assert.deepStrictEqual(await setPartnerCode(db, 2, 'SUESWAN'), { ok: true, code: 'SUESWAN' });
        });

        await check('a partner code resolves to its partner (approved only); a link code to its owner', async () => {
            assert.deepStrictEqual(await resolveInviteCode(db, 'samswan'), { referrerUserId: 1, firstName: 'Sam', code: 'SAMSWAN', partnerId: 1 });
            assert.deepStrictEqual(await resolveInviteCode(db, 'samlink1'), { referrerUserId: 1, firstName: 'Sam', code: 'SAMLINK1', partnerId: null });
            assert.strictEqual(await resolveInviteCode(db, 'SUESWAN'), null, 'a suspended partner\'s code does not work');
            assert.strictEqual(await resolveInviteCode(db, 'NOPE1234'), null);
        });

        await check('turning a code off stops it at once', async () => {
            assert.deepStrictEqual(await setPartnerCode(db, 2, null), { ok: true, code: null });
            const [p] = await sql.unsafe(`SELECT promo_code FROM partners WHERE id = 2`);
            assert.strictEqual(p.promo_code, null);
        });

        await check('a late code: not your own, not if you ever paid, once only — and then the friend offer applies', async () => {
            assert.match((await claimLateReferral(db, 1, 'SAMSWAN') as any).error, /your own code/);
            assert.match((await claimLateReferral(db, 11, 'SAMSWAN') as any).error, /new customers only/);
            assert.match((await claimLateReferral(db, 10, 'NOPE1234') as any).error, /recognise/);
            assert.deepStrictEqual(await claimLateReferral(db, 10, 'samswan'), { ok: true, firstName: 'Sam' }, 'a trial does not count as paid');
            assert.match((await claimLateReferral(db, 10, 'SAMLINK1') as any).error, /already on your account/);
            const offer = await findReferralOffer(db, 10);
            assert.strictEqual(offer?.referralCode, 'SAMSWAN');
        });

        await check('a partner-code customer earns the partner commission, recorded as came-in-on-the-code', async () => {
            await sql.unsafe(`INSERT INTO user_referrals (referrer_id, referred_user_id, referral_code, status) VALUES (1, 12, 'SAMLINK1', 'pending')`);
            const viaCode = await recordPartnerPayment(db, { userId: 10, paymentRef: 'in_code', paymentIntentId: 'pi_code', netAmountPence: 2900, currency: 'gbp', paidAt: new Date() });
            const viaLink = await recordPartnerPayment(db, { userId: 12, paymentRef: 'in_link', paymentIntentId: 'pi_link', netAmountPence: 2900, currency: 'gbp', paidAt: new Date() });
            assert.ok(viaCode.recorded && viaLink.recorded);
            const rows = await sql.unsafe(`SELECT ur.referred_user_id, pr.source FROM partner_referrals pr JOIN user_referrals ur ON ur.id = pr.referral_id ORDER BY ur.referred_user_id`);
            assert.deepStrictEqual(rows.map((r: any) => [r.referred_user_id, r.source]), [[10, 'promo_code'], [12, 'link']]);
        });
    } finally {
        await sql.unsafe(`SET search_path TO public`).catch(() => {});
        await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
        await sql.end();
    }
    console.log(`\n${passed} passed`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
