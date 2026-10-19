// tests/partner-erasure-db.test.ts
// Erasing a partner's personal data — on REAL Postgres, with the real vault (src/utils/partner-erasure.ts).
//
// WHY A DATABASE TEST. "Forget me" must remove the application, partner code and the payout details in
// the vault, while KEEPING the commission ledger (tax law, 7 years); applicant-only rows are deleted
// outright, but never one with money behind it; declined applications go after 12 months.
//
// ⚠️ Runs ONLY against a database on localhost (CI's rls job). db/client loads .env, and locally that
// is STAGING — this test must never create schemas there.
//
// Run:  npx tsx tests/partner-erasure-db.test.ts

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

async function main() {
    console.log('Partner erasure (real Postgres + vault)');
    const url = process.env.NETLIFY_DATABASE_URL;
    if (!isLocal(url)) { console.log('  ⊘ skipped — no LOCAL database (CI rls job only; never staging/prod)'); return; }
    process.env.VAULT_KEK_VERSION = '1';
    process.env.VAULT_KEK_1 = randomBytes(32).toString('hex');
    const { erasePartnerDataForUser, deleteApplicantOnly, purgeDeclinedApplications } = await import('../src/utils/partner-erasure');
    const { storeSecret, getSecret } = await import('../src/utils/vault');

    const schema = `partner_erasure_test_${Date.now()}`;
    const sql = postgres(url, { max: 1 });
    try {
        await sql.unsafe(`CREATE SCHEMA ${schema}`);
        for (const t of ['partners', 'partner_commissions', 'vault_secrets']) await sql.unsafe(`CREATE TABLE ${schema}.${t} (LIKE public.${t} INCLUDING ALL)`);
        await sql.unsafe(`SET search_path TO ${schema}`);
        const db = drizzle({ client: sql }) as never;
        await sql.unsafe(`INSERT INTO partners (id, user_id, status, applicant_name, applicant_email, application, promo_code, payout_method, payout_display, payout_details_confirmed_at, vat_number, terms_version)
                          VALUES (1, 50, 'approved', 'Sam Partner', 'sam@example.com', '{"Audience":"4,000 readers"}', 'SAMSWAN', 'paypal', 'PayPal · s***@example.com', now(), 'GB123456789', '1.0')`);
        await sql.unsafe(`INSERT INTO partner_commissions (partner_id, kind, stripe_invoice_id, net_amount_pence, rate_bps, commission_pence, status, available_at) VALUES (1, 'invoice', 'in_1', 2900, 2500, 725, 'paid', now())`);
        await storeSecret(db, 'aura/partner-1/payout', { method: 'paypal', email: 'sam.pay@example.com' });
        await storeSecret(db, 'aura/partner-1/payout-pending', { method: 'paypal', email: 'new@example.com' });

        await check('erasing a partner: identifying fields and vault payout details gone, suspended, ledger kept', async () => {
            assert.deepStrictEqual(await erasePartnerDataForUser(db, 50), { erased: true, partnerId: 1 });
            const [p] = await sql.unsafe(`SELECT status, applicant_name, applicant_email, application, promo_code, payout_display, payout_method, vat_number FROM partners WHERE id = 1`);
            assert.deepStrictEqual(
                [p.status, p.applicant_name, p.applicant_email, p.promo_code, p.payout_display, p.payout_method, p.vat_number],
                ['suspended', null, null, null, null, null, null]);
            assert.deepStrictEqual(p.application, { erased: true });
            assert.strictEqual(await getSecret(db, 'aura/partner-1/payout'), null);
            assert.strictEqual(await getSecret(db, 'aura/partner-1/payout-pending'), null);
            const [{ n }] = await sql.unsafe(`SELECT count(*)::int AS n FROM partner_commissions WHERE partner_id = 1`);
            assert.strictEqual(n, 1, 'the ledger stays (tax law)');
            assert.deepStrictEqual(await erasePartnerDataForUser(db, 999), { erased: false, partnerId: null });
        });

        await check('an applicant with no account is deleted outright — never one with an account or money behind it', async () => {
            await sql.unsafe(`INSERT INTO partners (id, user_id, status, applicant_email) VALUES (2, NULL, 'applied', 'jo@example.com'), (3, NULL, 'rejected', 'm@example.com'), (4, 60, 'applied', 'a@example.com')`);
            await sql.unsafe(`INSERT INTO partner_commissions (partner_id, kind, commission_pence, status, available_at, note) VALUES (3, 'bonus', 100, 'payable', now(), 'x')`);
            assert.strictEqual(await deleteApplicantOnly(db, 2), true);
            assert.strictEqual(await deleteApplicantOnly(db, 3), false, 'has money behind it');
            assert.strictEqual(await deleteApplicantOnly(db, 4), false, 'has an account');
            assert.strictEqual(await deleteApplicantOnly(db, 1), false, 'a partner');
        });

        await check('declined applications without an account go 12 months after the decision', async () => {
            await sql.unsafe(`INSERT INTO partners (id, user_id, status, applicant_email, decided_at) VALUES
                (5, NULL, 'rejected', 'old@example.com', now() - make_interval(days => 400)),
                (6, NULL, 'rejected', 'recent@example.com', now() - make_interval(days => 100)),
                (7, NULL, 'applied', 'waiting@example.com', now() - make_interval(days => 400))`);
            assert.deepStrictEqual(await purgeDeclinedApplications(db), { deleted: 1 });
            const left = (await sql.unsafe(`SELECT id FROM partners WHERE id IN (5, 6, 7) ORDER BY id`)).map((r: any) => r.id);
            assert.deepStrictEqual(left, [6, 7]);
        });
    } finally {
        await sql.unsafe(`SET search_path TO public`).catch(() => {});
        await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
        await sql.end();
    }
    console.log(`\n${passed} passed`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
