// tests/partner-payout-runs-db.test.ts
// The ledger actions and a monthly payout run — on REAL Postgres, with the real vault
// (src/utils/partner-payout-batches.ts).
//
// WHY A DATABASE TEST. Who is due (confirmed details, minimum, refunds netted), locking rows into a
// run under an advisory lock, a second run finding nothing to pay twice, and paid / cancelled moving
// every row — this is the step that sends money, and only Postgres proves it.
//
// ⚠️ Runs ONLY against a database on localhost (CI's rls job). db/client loads .env, and locally that
// is STAGING — this test must never create schemas there.
//
// Run:  npx tsx tests/partner-payout-runs-db.test.ts

import { PARTNER_TERMS_VERSION } from '../src/config/partner-terms';
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

const TABLES = ['users', 'partners', 'partner_commissions', 'partner_payout_batches', 'partner_programme_settings', 'vault_secrets'];

async function main() {
    console.log('Ledger actions and payout runs (real Postgres + vault)');
    const url = process.env.NETLIFY_DATABASE_URL;
    if (!isLocal(url)) { console.log('  ⊘ skipped — no LOCAL database (CI rls job only; never staging/prod)'); return; }
    process.env.VAULT_KEK_VERSION = '1';
    process.env.VAULT_KEK_1 = randomBytes(32).toString('hex');
    const runs = await import('../src/utils/partner-payout-batches');
    const { storeSecret } = await import('../src/utils/vault');

    const schema = `partner_runs_test_${Date.now()}`;
    const sql = postgres(url, { max: 1 });
    try {
        await sql.unsafe(`CREATE SCHEMA ${schema}`);
        for (const t of TABLES) await sql.unsafe(`CREATE TABLE ${schema}.${t} (LIKE public.${t} INCLUDING ALL)`);
        await sql.unsafe(`SET search_path TO ${schema}`);
        const db = drizzle({ client: sql }) as never;
        await sql.unsafe(`INSERT INTO partner_programme_settings (id, min_payout_pence) VALUES (1, 5000)`);
        await sql.unsafe(`INSERT INTO users (id, email, first_name, last_name, role) VALUES
            (1, 'ann@example.com', 'Ann', 'Bank', 'user'), (2, 'pam@example.com', 'Pam', 'Pal', 'user'),
            (3, 'nod@example.com', 'No', 'Details', 'user'), (4, 'low@example.com', 'Low', 'Balance', 'user'),
            (5, 'sus@example.com', 'Sue', 'Spended', 'user'), (6, 'ref@example.com', 'Ref', 'Unded', 'user'),
            (7, 'old@example.com', 'Old', 'Terms', 'user')`);
        // Partners 1–7 (ids follow users): confirmed details for 1, 2, 4, 5, 6, 7; none for 3.
        // 1–6 accepted the current Partner Terms; 7 only an older version (or an admin added them).
        for (const [uid, status, method, display] of [[1, 'approved', 'bank', 'UK bank · Ann Bank · ****4567'], [2, 'approved', 'paypal', 'PayPal · p***@example.com'],
            [3, 'approved', null, null], [4, 'approved', 'paypal', 'PayPal · l***@example.com'], [5, 'suspended', 'paypal', 'PayPal · s***@example.com'], [6, 'approved', 'paypal', 'PayPal · r***@example.com']] as const) {
            await sql.unsafe(`INSERT INTO partners (id, user_id, status, payout_method, payout_display, payout_details_confirmed_at, terms_version)
                              VALUES (${uid}, ${uid}, '${status}', ${method ? `'${method}'` : 'NULL'}, ${display ? `'${display}'` : 'NULL'}, ${display ? 'now()' : 'NULL'}, '${PARTNER_TERMS_VERSION}')`);
        }
        await sql.unsafe(`INSERT INTO partners (id, user_id, status, payout_method, payout_display, payout_details_confirmed_at, terms_version)
                          VALUES (7, 7, 'approved', 'paypal', 'PayPal · o***@example.com', now(), '1.0')`);
        await storeSecret(db, 'aura/partner-1/payout', { method: 'bank', accountName: 'Ann Bank', sortCode: '112233', accountNumber: '01234567' });
        await storeSecret(db, 'aura/partner-2/payout', { method: 'paypal', email: 'pam.pay@example.com' });
        await storeSecret(db, 'aura/partner-5/payout', { method: 'paypal', email: 'sue.pay@example.com' });
        const add = (pid: number, pence: number, status = 'payable', kind = 'invoice', inv: string | null = null) => sql.unsafe(
            `INSERT INTO partner_commissions (partner_id, kind, stripe_invoice_id, net_amount_pence, rate_bps, commission_pence, status, available_at)
             VALUES (${pid}, '${kind}', ${kind === 'invoice' ? `'${inv ?? `in_${pid}_${Math.random().toString(36).slice(2)}`}'` : 'NULL'}, ${kind === 'invoice' ? pence * 4 : 'NULL'}, ${kind === 'invoice' ? 2500 : 'NULL'}, ${pence}, '${status}', now())`);
        await add(1, 6000); await add(1, 1500);           // Ann: £75 → due
        await add(2, 7525);                               // Pam: £75.25 → due
        await add(3, 9000);                               // no details → left out
        await add(4, 2000);                               // under £50 → rolls over
        await add(5, 5500);                               // suspended keeps what they earned → due
        await add(6, 6000); await add(6, -3000, 'payable', 'adjustment');   // refunded after payout: £30 net → under minimum
        await add(7, 8000);                               // Terms not accepted → waits
        await add(1, 9999, 'pending');                    // not ready yet → never in a run

        await check('who is due: confirmed details, at or over the minimum, refunds netted, suspended included', async () => {
            const p = await runs.previewPayout(db);
            const by = Object.fromEntries(p.lines.map((l) => [l.partnerId, l]));
            assert.deepStrictEqual([by[1].due, by[1].amountPence], [true, 7500]);
            assert.deepStrictEqual([by[2].due, by[5].due], [true, true]);
            assert.match(by[3].reason!, /No confirmed payout details/);
            assert.match(by[4].reason!, /Under the £50 minimum/);
            assert.deepStrictEqual([by[7].due, by[7].amountPence], [false, 8000]);
            assert.match(by[7].reason!, /Hasn’t accepted the Partner Terms/);
            assert.deepStrictEqual([by[6].due, by[6].amountPence], [false, 3000]);
            assert.strictEqual(p.totalDuePence, 7500 + 7525 + 5500);
        });

        let batchId = 0;
        await check('a run locks exactly the due rows; a second run finds nobody to pay twice', async () => {
            const r = await runs.createBatch(db, 99);
            assert.ok(r.ok);
            batchId = (r as any).batchId;
            assert.deepStrictEqual([(r as any).totalPence, (r as any).partnerCount], [20525, 3]);
            const [{ n }] = await sql.unsafe(`SELECT count(*)::int AS n FROM partner_commissions WHERE payout_batch_id = ${batchId}`);
            assert.strictEqual(n, 4);
            assert.deepStrictEqual(await runs.createBatch(db, 99), { ok: false, error: 'Nobody is due a payout right now.' });
        });

        await check('money in a run cannot be cancelled; money outside one can, with a reason', async () => {
            const [inRun] = await sql.unsafe(`SELECT id FROM partner_commissions WHERE payout_batch_id = ${batchId} LIMIT 1`);
            assert.strictEqual((await runs.voidCommission(db, inRun.id, 'oops')).ok, false);
            const [free] = await sql.unsafe(`SELECT id FROM partner_commissions WHERE partner_id = 4 LIMIT 1`);
            assert.strictEqual((await runs.voidCommission(db, free.id, '')).ok, false, 'a reason is required');
            assert.strictEqual((await runs.voidCommission(db, free.id, 'Self-referral')).ok, true);
        });

        await check('the files come from the vault: Ann in the bank file, Pam and Sue in PayPal', async () => {
            const lines = await runs.batchLines(db, batchId);
            const bank = runs.buildExport('wise_bank', batchId, lines);
            assert.ok(bank.csv.includes(`Ann Bank,ann@example.com,BMS PARTNER ${batchId},PRIVATE,GBP,75.00,GBP,GBP,112233,01234567`), bank.csv);
            const pp = runs.buildExport('paypal', batchId, lines);
            assert.deepStrictEqual([pp.included, pp.totalPence], [2, 13025]);
            await runs.markExported(db, batchId);
            const [b] = await sql.unsafe(`SELECT status FROM partner_payout_batches WHERE id = ${batchId}`);
            assert.strictEqual(b.status, 'exported');
        });

        await check('cancelling a run puts its money back; a new run picks it up; marking paid pays every row once', async () => {
            assert.deepStrictEqual(await runs.cancelBatch(db, batchId), { ok: true });
            const [{ n }] = await sql.unsafe(`SELECT count(*)::int AS n FROM partner_commissions WHERE payout_batch_id IS NULL AND status = 'payable' AND partner_id IN (1, 2, 5)`);
            assert.strictEqual(n, 4);
            const again = await runs.createBatch(db, 99) as any;
            assert.strictEqual(again.totalPence, 20525);
            assert.deepStrictEqual(await runs.markBatchPaid(db, again.batchId, 99), { ok: true });
            const [{ paid }] = await sql.unsafe(`SELECT count(*)::int AS paid FROM partner_commissions WHERE payout_batch_id = ${again.batchId} AND status = 'paid' AND paid_at IS NOT NULL`);
            assert.strictEqual(paid, 4);
            assert.strictEqual((await runs.markBatchPaid(db, again.batchId, 99)).ok, false, 'a paid run cannot be paid again');
            assert.strictEqual((await runs.cancelBatch(db, again.batchId)).ok, false, 'nor cancelled');
        });

        await check('a bonus is ready to pay at once, for approved or suspended partners only', async () => {
            const r = await runs.addBonus(db, 4, 4000, 'Great month', 99);
            assert.ok(r.ok);
            const p = await runs.previewPayout(db);
            assert.strictEqual(p.lines.find((l) => l.partnerId === 4)!.amountPence, 4000, 'the voided £20 is gone; the £40 bonus is there');
            assert.strictEqual((await runs.addBonus(db, 4, 0, 'x', 99)).ok, false);
        });

        await check('the ledger lists newest first and filters by status', async () => {
            const paid = await runs.listLedger(db, 'paid');
            assert.ok(paid.length === 4 && paid.every((r) => r.status === 'paid'));
            assert.ok((await runs.listLedger(db, null)).length >= 10);
        });
    } finally {
        await sql.unsafe(`SET search_path TO public`).catch(() => {});
        await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
        await sql.end();
    }
    console.log(`\n${passed} passed`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
