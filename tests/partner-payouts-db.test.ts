// tests/partner-payouts-db.test.ts
// A partner's payout details and their Partner page numbers — on REAL Postgres, with the real vault
// (src/utils/partner-payouts.ts, src/utils/vault.ts, src/utils/partner-ops.ts partnerHubSummary).
//
// WHY A DATABASE TEST. Where money goes must change only through the emailed confirmation, once,
// by the right partner, within 24 hours — a conditional UPDATE on a token hash, plus a vault
// secret moved from "pending" to "live". And the Partner page's numbers are FILTERed aggregates over
// four tables. Neither is provable with mocks.
//
// HOW. Copies of the tables (`LIKE … INCLUDING ALL`, no foreign keys) in a throwaway schema, one
// connection; a throwaway vault key. Emails are recorded, not sent.
//
// ⚠️ Runs ONLY against a database on localhost (CI's rls job). db/client loads .env, and locally that
// is STAGING — this test must never create schemas there.
//
// Run:  npx tsx tests/partner-payouts-db.test.ts

import assert from 'node:assert';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

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
function recorder() {
    const sent: Array<{ triggerKey: string; to: string; vars?: any }> = [];
    return { sent, send: (async (p: any) => { sent.push(p); return null; }) as any };
}

const TABLES = ['users', 'partners', 'vault_secrets', 'email_templates', 'user_referrals', 'partner_referrals', 'partner_commissions', 'partner_link_stats'];

async function main() {
    console.log('Partner payout details and Partner page numbers (real Postgres + vault)');
    const url = process.env.NETLIFY_DATABASE_URL;
    if (!isLocal(url)) { console.log('  ⊘ skipped — no LOCAL database (CI rls job only; never staging/prod)'); return; }
    process.env.VAULT_KEK_VERSION = '1';
    process.env.VAULT_KEK_1 = randomBytes(32).toString('hex');   // throwaway key for this run only
    const { requestPayoutChange, confirmPayoutChange, cancelPayoutChange, getPayoutDetails, pendingPayoutRefKey } = await import('../src/utils/partner-payouts');
    const { partnerHubSummary } = await import('../src/utils/partner-ops');

    const schema = `partner_payouts_test_${Date.now()}`;
    const sql = postgres(url, { max: 1 });
    try {
        await sql.unsafe(`CREATE SCHEMA ${schema}`);
        for (const t of TABLES) await sql.unsafe(`CREATE TABLE ${schema}.${t} (LIKE public.${t} INCLUDING ALL)`);
        await sql.unsafe(`SET search_path TO ${schema}`);
        const db = drizzle({ client: sql }) as never;
        await sql.unsafe(`INSERT INTO users (id, email, first_name, role) VALUES (70, 'pat@example.com', 'Pat', 'user'), (71, 'other@example.com', 'Oth', 'user')`);
        const [p] = await sql.unsafe(`INSERT INTO partners (user_id, status, decided_at) VALUES (70, 'approved', now() - make_interval(days => 40)) RETURNING id`);
        const [other] = await sql.unsafe(`INSERT INTO partners (user_id, status) VALUES (71, 'approved') RETURNING id`);
        const tokenOf = (r: ReturnType<typeof recorder>) => new URL(r.sent[r.sent.length - 1].vars.link.action_url).searchParams.get('payoutToken')!;

        let token = '';
        await check('a change waits: masked summary + hashed token on the row, details encrypted in the vault, link to the ACCOUNT email', async () => {
            const r = recorder();
            const out = await requestPayoutChange(db, p.id, { method: 'paypal', email: 'pat.pay@example.com' }, new Date(), r.send);
            assert.deepStrictEqual(out, { display: 'PayPal · p***@example.com', sentTo: 'pat@example.com' });
            token = tokenOf(r);
            const [row] = await sql.unsafe(`SELECT payout_method, payout_display, payout_pending_display, payout_pending_token_hash FROM partners WHERE id = ${p.id}`);
            assert.deepStrictEqual([row.payout_method, row.payout_display, row.payout_pending_display], [null, null, 'PayPal · p***@example.com'], 'nothing live yet');
            assert.ok(row.payout_pending_token_hash && row.payout_pending_token_hash !== token);
            const [secret] = await sql.unsafe(`SELECT encrypted_payload FROM vault_secrets WHERE ref_key = '${pendingPayoutRefKey(p.id)}'`);
            assert.ok(secret && !String(secret.encrypted_payload).includes('pat.pay'), 'the vault holds ciphertext, not the email');
        });

        await check("another partner can't use the link, and nor can anyone after 24 hours", async () => {
            assert.strictEqual((await confirmPayoutChange(db, other.id, token)).ok, false);
            assert.strictEqual((await confirmPayoutChange(db, p.id, token, new Date(Date.now() + 25 * 3_600_000))).ok, false);
        });

        await check('confirming makes it live once, moves the secret, and sends a "changed" email', async () => {
            const out = await confirmPayoutChange(db, p.id, token);
            assert.deepStrictEqual(out, { ok: true, display: 'PayPal · p***@example.com' });
            assert.deepStrictEqual(await getPayoutDetails(db, p.id), { method: 'paypal', email: 'pat.pay@example.com' });
            const [pending] = await sql.unsafe(`SELECT count(*)::int AS n FROM vault_secrets WHERE ref_key = '${pendingPayoutRefKey(p.id)}'`);
            assert.strictEqual(pending.n, 0);
            assert.strictEqual((await confirmPayoutChange(db, p.id, token)).ok, false, 'a spent link does nothing');
        });

        await check('a later change leaves the confirmed details in place until it too is confirmed; cancel drops it', async () => {
            const r = recorder();
            await requestPayoutChange(db, p.id, { method: 'bank', accountName: 'Pat Example', sortCode: '112233', accountNumber: '87654321' }, new Date(), r.send);
            assert.deepStrictEqual(await getPayoutDetails(db, p.id), { method: 'paypal', email: 'pat.pay@example.com' }, 'still PayPal');
            await cancelPayoutChange(db, p.id);
            assert.strictEqual((await confirmPayoutChange(db, p.id, tokenOf(r))).ok, false, 'a cancelled change cannot be confirmed');
            const [row] = await sql.unsafe(`SELECT payout_display, payout_pending_display FROM partners WHERE id = ${p.id}`);
            assert.deepStrictEqual([row.payout_display, row.payout_pending_display], ['PayPal · p***@example.com', null]);
        });

        await check("the Partner page's numbers: visits, sign-ups since approval, paying, money by status", async () => {
            await sql.unsafe(`INSERT INTO partner_link_stats (partner_id, day, clicks) VALUES
                (${p.id}, (now() AT TIME ZONE 'Europe/London')::date, 5), (${p.id}, (now() AT TIME ZONE 'Europe/London')::date - 10, 3), (${p.id}, (now() AT TIME ZONE 'Europe/London')::date - 60, 7)`);
            await sql.unsafe(`INSERT INTO user_referrals (referrer_id, referred_user_id, referral_code, status, created_at) VALUES
                (70, 201, 'PAT', 'partner', now() - make_interval(days => 5)),
                (70, 202, 'PAT', 'pending', now() - make_interval(days => 3)),
                (70, 203, 'PAT', 'qualified', now() - make_interval(days => 90))`);   // before they were a partner: token track
            const refs = await sql.unsafe(`SELECT id, referred_user_id FROM user_referrals WHERE referred_user_id = 201`);
            const [pr] = await sql.unsafe(`INSERT INTO partner_referrals (referral_id, partner_id, subscribed_at, rate_bps, duration_months) VALUES (${refs[0].id}, ${p.id}, now(), 2500, 12) RETURNING id`);
            await sql.unsafe(`INSERT INTO partner_commissions (partner_id, partner_referral_id, kind, stripe_invoice_id, net_amount_pence, rate_bps, commission_pence, status, available_at) VALUES
                (${p.id}, ${pr.id}, 'invoice', 'in_a', 2900, 2500, 725, 'pending', now() + make_interval(days => 20)),
                (${p.id}, ${pr.id}, 'invoice', 'in_b', 2900, 2500, 725, 'payable', now()),
                (${p.id}, ${pr.id}, 'invoice', 'in_c', 2900, 2500, 725, 'voided', now())`);
            const { stats, commissions } = await partnerHubSummary(db, p.id);
            assert.deepStrictEqual(
                { c7: stats.clicks_7d, c30: stats.clicks_30d, all: stats.clicks_all, signups: stats.signups, paying: stats.paying, pending: stats.pending_pence, payable: stats.payable_pence, paid: stats.paid_pence },
                { c7: 5, c30: 8, all: 15, signups: 2, paying: 1, pending: 725, payable: 725, paid: 0 });
            assert.ok(stats.next_release_at, 'when the next pending amount is ready');
            assert.strictEqual(commissions.length, 3);
            assert.ok(commissions.every((c: any) => c.customer_no === 1), 'customers are numbered, never named');
        });
    } finally {
        await sql.unsafe(`SET search_path TO public`).catch(() => {});
        await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
        await sql.end();
    }
    console.log(`\n${passed} passed`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
