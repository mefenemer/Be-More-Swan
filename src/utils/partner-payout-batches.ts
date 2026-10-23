// src/utils/partner-payout-batches.ts
// Affiliate Partner Programme, step 6 — the admin ledger actions and the monthly payout run
// (docs/affiliate-partner-programme-plan.md §4.4–4.5). Used by admin-partners.ts (the screen) and,
// through action cards, the Partner Ops chat — one implementation for both.
//
// A payout run:
//   previewPayout  → who is due: approved, suspended or ended partners (they keep what they earned, Terms 7.3) who
//                    have accepted the CURRENT Partner Terms, with CONFIRMED payout details, whose ready-to-pay balance (refund adjustments included)
//                    reaches the minimum. Everyone else is listed with the reason they're left out.
//   createBatch    → locks those rows into a 'draft' batch (payout_batch_id), in one transaction under
//                    an advisory lock so two admins can't batch the same money twice.
//   export files   → Wise (UK bank, and Wise-by-email) and PayPal. Built from the VAULT details; the
//                    first export marks the batch 'exported'.
//   markBatchPaid  → after paying in Wise / PayPal: every row in it becomes 'paid'.
//   cancelBatch    → before it's paid: the rows go back to ready-to-pay.
//
// Money is integer pence throughout; files show pounds with two decimals.

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { partnerCommissions, partnerPayoutBatches, partnerProgrammeSettings, partners } from '../../db/schema';
import { getPayoutDetails, type PayoutDetails } from './partner-payouts';
import { PARTNER_TERMS_VERSION, hasAcceptedCurrentTerms } from '../config/partner-terms';

type Db = ReturnType<typeof getDb>;
type Row = Record<string, any>;

// ── Ledger actions ───────────────────────────────────────────────────────────────────────────

/** Cancel one commission. Only money not yet in a payout run can be cancelled. */
export async function voidCommission(db: Db, commissionId: number, reason: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const why = reason.trim().slice(0, 200);
    if (!why) return { ok: false, error: 'Say why it is being cancelled — the partner sees the reason.' };
    const updated = await db.update(partnerCommissions)
        .set({ status: 'voided', voidedAt: new Date(), voidReason: why })
        .where(and(eq(partnerCommissions.id, commissionId), inArray(partnerCommissions.status, ['pending', 'payable']), isNull(partnerCommissions.payoutBatchId)))
        .returning({ id: partnerCommissions.id });
    return updated.length ? { ok: true } : { ok: false, error: 'Only a pending or ready-to-pay commission that is not in a payout run can be cancelled.' };
}

/** A goodwill payment, ready to pay straight away. */
export async function addBonus(db: Db, partnerId: number, amountPence: number, note: string, adminId: number): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
    if (!Number.isInteger(amountPence) || amountPence <= 0 || amountPence > 1_000_000) return { ok: false, error: 'A bonus must be between £0.01 and £10,000.' };
    const why = note.trim().slice(0, 200);
    if (!why) return { ok: false, error: 'Add a note — the partner sees it as the reason for the bonus.' };
    const [p] = await db.select({ id: partners.id, status: partners.status }).from(partners).where(eq(partners.id, partnerId)).limit(1);
    if (!p || !['approved', 'suspended', 'ended'].includes(p.status)) return { ok: false, error: 'Bonuses are for approved, suspended or ended partners only.' };
    const [row] = await db.insert(partnerCommissions).values({
        partnerId, kind: 'bonus', commissionPence: amountPence, status: 'payable', availableAt: new Date(), note: why, createdBy: adminId,
    }).returning({ id: partnerCommissions.id });
    return { ok: true, id: row.id };
}

// ── The payout run ───────────────────────────────────────────────────────────────────────────

export interface PayoutPreviewLine {
    partnerId: number; name: string | null; email: string | null; method: string | null; payoutDisplay: string | null;
    amountPence: number; due: boolean; reason: string | null;
}

/** Who is due, and who isn't (and why). Ready-to-pay rows not already in a batch. */
export async function previewPayout(db: Db): Promise<{ minPayoutPence: number; lines: PayoutPreviewLine[]; totalDuePence: number }> {
    const [settings] = await db.select({ min: partnerProgrammeSettings.minPayoutPence }).from(partnerProgrammeSettings).where(eq(partnerProgrammeSettings.id, 1)).limit(1);
    const min = settings?.min ?? 5000;
    const rows = (await db.execute(sql`
        SELECT p.id, p.status, p.terms_version, p.payout_method, p.payout_display, p.payout_details_confirmed_at,
               COALESCE(u.email, p.applicant_email) AS email,
               NULLIF(TRIM(COALESCE(u.first_name, p.applicant_name, '') || ' ' || COALESCE(u.last_name, '')), '') AS name,
               SUM(c.commission_pence)::int AS amount
          FROM partner_commissions c
          JOIN partners p ON p.id = c.partner_id
          LEFT JOIN users u ON u.id = p.user_id
         WHERE c.status = 'payable' AND c.payout_batch_id IS NULL
         GROUP BY p.id, u.email, u.first_name, u.last_name
         ORDER BY amount DESC`)) as unknown as Row[];
    const lines: PayoutPreviewLine[] = rows.map((r) => {
        const amount = Number(r.amount);
        // Suspended and ended partners are still paid what they earned (Partner Terms 7.3).
        const reason = !['approved', 'suspended', 'ended'].includes(r.status) ? `Partner is ${r.status}`
            // No contract, no payout: it waits (and rolls over) until they accept on their Partner page.
            : !hasAcceptedCurrentTerms(r.terms_version) ? `Hasn’t accepted the Partner Terms (v${PARTNER_TERMS_VERSION}) — it waits until they do`
            : !r.payout_details_confirmed_at || !r.payout_display ? 'No confirmed payout details'
            : amount < min ? `Under the £${(min / 100).toFixed(0)} minimum — rolls over`
            : null;
        return { partnerId: r.id, name: r.name, email: r.email, method: r.payout_method, payoutDisplay: r.payout_display, amountPence: amount, due: !reason && amount > 0, reason: amount <= 0 && !reason ? 'Nothing to pay after refunds' : reason };
    });
    return { minPayoutPence: min, lines, totalDuePence: lines.filter((l) => l.due).reduce((s, l) => s + l.amountPence, 0) };
}

/** Lock everyone due into a draft batch. Refuses if nobody is due. */
export async function createBatch(db: Db, adminId: number): Promise<{ ok: true; batchId: number; totalPence: number; partnerCount: number } | { ok: false; error: string }> {
    return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('partner_payout_batches'))`);
        const preview = await previewPayout(tx as unknown as Db);
        const due = preview.lines.filter((l) => l.due);
        if (!due.length) return { ok: false as const, error: 'Nobody is due a payout right now.' };
        const [batch] = await tx.insert(partnerPayoutBatches).values({ status: 'draft', createdBy: adminId, totalPence: 0, partnerCount: 0 }).returning({ id: partnerPayoutBatches.id });
        await tx.update(partnerCommissions).set({ payoutBatchId: batch.id })
            .where(and(eq(partnerCommissions.status, 'payable'), isNull(partnerCommissions.payoutBatchId), inArray(partnerCommissions.partnerId, due.map((d) => d.partnerId))));
        const [{ total, count }] = (await tx.execute(sql`
            SELECT COALESCE(SUM(commission_pence), 0)::int AS total, COUNT(DISTINCT partner_id)::int AS count
              FROM partner_commissions WHERE payout_batch_id = ${batch.id}`)) as unknown as Array<{ total: number; count: number }>;
        await tx.update(partnerPayoutBatches).set({ totalPence: total, partnerCount: count }).where(eq(partnerPayoutBatches.id, batch.id));
        return { ok: true as const, batchId: batch.id, totalPence: total, partnerCount: count };
    });
}

export async function markBatchPaid(db: Db, batchId: number, adminId: number): Promise<{ ok: true } | { ok: false; error: string }> {
    return db.transaction(async (tx) => {
        const now = new Date();
        const updated = await tx.update(partnerPayoutBatches).set({ status: 'paid', paidAt: now, paidBy: adminId })
            .where(and(eq(partnerPayoutBatches.id, batchId), inArray(partnerPayoutBatches.status, ['draft', 'exported']))).returning({ id: partnerPayoutBatches.id });
        if (!updated.length) return { ok: false as const, error: 'Only a draft or exported payout run can be marked paid.' };
        await tx.update(partnerCommissions).set({ status: 'paid', paidAt: now }).where(eq(partnerCommissions.payoutBatchId, batchId));
        return { ok: true as const };
    });
}

export async function cancelBatch(db: Db, batchId: number): Promise<{ ok: true } | { ok: false; error: string }> {
    return db.transaction(async (tx) => {
        const updated = await tx.update(partnerPayoutBatches).set({ status: 'cancelled' })
            .where(and(eq(partnerPayoutBatches.id, batchId), inArray(partnerPayoutBatches.status, ['draft', 'exported']))).returning({ id: partnerPayoutBatches.id });
        if (!updated.length) return { ok: false as const, error: 'A paid payout run cannot be cancelled.' };
        await tx.update(partnerCommissions).set({ payoutBatchId: null }).where(and(eq(partnerCommissions.payoutBatchId, batchId), eq(partnerCommissions.status, 'payable')));
        return { ok: true as const };
    });
}

// ── Export files ─────────────────────────────────────────────────────────────────────────────

/**
 * Wise batch-file headers. ⚠️ Taken from the field names Wise documents (sourceCurrency,
 * targetCurrency, amountCurrency, amount, name, recipientEmail, paymentReference, receiverType) —
 * Wise's templates vary by type, so compare these once with the template downloaded from Wise
 * (Batch payments → template) before the first real payout, and change them HERE if they differ.
 */
export const WISE_BANK_HEADERS = ['name', 'recipientEmail', 'paymentReference', 'receiverType', 'amountCurrency', 'amount', 'sourceCurrency', 'targetCurrency', 'sortCode', 'accountNumber'];
export const WISE_EMAIL_HEADERS = ['name', 'recipientEmail', 'paymentReference', 'receiverType', 'amountCurrency', 'amount', 'sourceCurrency', 'targetCurrency'];
export type ExportFormat = 'wise_bank' | 'wise_email' | 'paypal';

const csvCell = (v: string) => /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
/** A spreadsheet treats a leading = + - @ as a formula; neutralise it (CSV injection). */
const safe = (v: string) => /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
const pounds = (p: number) => (p / 100).toFixed(2);
/** UK Faster Payments references are 18 characters. */
export const paymentReference = (batchId: number) => `BMS PARTNER ${batchId}`.slice(0, 18);

export interface BatchLine { partnerId: number; name: string; email: string; amountPence: number; details: PayoutDetails | null }

/** Each partner in the batch, with their decrypted payout details. Server-side only. */
export async function batchLines(db: Db, batchId: number): Promise<BatchLine[]> {
    const rows = (await db.execute(sql`
        SELECT c.partner_id, SUM(c.commission_pence)::int AS amount,
               COALESCE(u.email, p.applicant_email) AS email,
               NULLIF(TRIM(COALESCE(u.first_name, p.applicant_name, '') || ' ' || COALESCE(u.last_name, '')), '') AS name
          FROM partner_commissions c JOIN partners p ON p.id = c.partner_id LEFT JOIN users u ON u.id = p.user_id
         WHERE c.payout_batch_id = ${batchId}
         GROUP BY c.partner_id, u.email, u.first_name, u.last_name, p.applicant_email, p.applicant_name
         ORDER BY c.partner_id`)) as unknown as Row[];
    const out: BatchLine[] = [];
    for (const r of rows) {
        out.push({ partnerId: r.partner_id, name: r.name || r.email || `Partner ${r.partner_id}`, email: r.email || '', amountPence: Number(r.amount), details: await getPayoutDetails(db, r.partner_id) });
    }
    return out;
}

/** One payment file. Lines for other methods (or with no details) are left out and counted. */
export function buildExport(format: ExportFormat, batchId: number, lines: BatchLine[]): { csv: string; included: number; skipped: number; totalPence: number } {
    const ref = paymentReference(batchId);
    const rows: string[][] = [];
    let total = 0;
    for (const l of lines) {
        const d = l.details;
        if (!d || l.amountPence <= 0) continue;
        if (format === 'wise_bank' && d.method === 'bank') {
            rows.push([d.accountName, l.email, ref, 'PRIVATE', 'GBP', pounds(l.amountPence), 'GBP', 'GBP', d.sortCode, d.accountNumber]);
        } else if (format === 'wise_email' && d.method === 'wise') {
            rows.push([l.name, d.email, ref, 'PRIVATE', 'GBP', pounds(l.amountPence), 'GBP', 'GBP']);
        } else if (format === 'paypal' && d.method === 'paypal') {
            // PayPal Payouts upload: no header row; email, amount, currency, customer id, note, wallet.
            rows.push([d.email, pounds(l.amountPence), 'GBP', `P${l.partnerId}-B${batchId}`, 'Be More Swan partner commission', 'PAYPAL']);
        } else continue;
        total += l.amountPence;
    }
    const header = format === 'wise_bank' ? [WISE_BANK_HEADERS] : format === 'wise_email' ? [WISE_EMAIL_HEADERS] : [];
    const csv = [...header, ...rows].map((r) => r.map((v) => csvCell(safe(String(v)))).join(',')).join('\r\n') + '\r\n';
    return { csv, included: rows.length, skipped: lines.length - rows.length, totalPence: total };
}

/** The first export of a draft batch marks it exported. */
export async function markExported(db: Db, batchId: number): Promise<void> {
    await db.update(partnerPayoutBatches).set({ status: 'exported', exportedAt: new Date() })
        .where(and(eq(partnerPayoutBatches.id, batchId), eq(partnerPayoutBatches.status, 'draft')));
}

/** Batches, newest first, with how they split by payout method (for which files to download). */
export async function listBatches(db: Db): Promise<Row[]> {
    return (await db.execute(sql`
        SELECT b.id, b.status, b.total_pence, b.partner_count, b.created_at, b.exported_at, b.paid_at,
               COUNT(DISTINCT c.partner_id) FILTER (WHERE p.payout_method = 'bank')::int AS bank_partners,
               COUNT(DISTINCT c.partner_id) FILTER (WHERE p.payout_method = 'wise')::int AS wise_partners,
               COUNT(DISTINCT c.partner_id) FILTER (WHERE p.payout_method = 'paypal')::int AS paypal_partners
          FROM partner_payout_batches b
          LEFT JOIN partner_commissions c ON c.payout_batch_id = b.id
          LEFT JOIN partners p ON p.id = c.partner_id
         GROUP BY b.id ORDER BY b.created_at DESC LIMIT 24`)) as unknown as Row[];
}

/** The ledger, newest first, optionally one status. */
export async function listLedger(db: Db, status: string | null, limit = 200): Promise<Row[]> {
    const st = status && ['pending', 'payable', 'paid', 'voided'].includes(status) ? status : null;
    return (await db.execute(sql`
        SELECT c.id, c.partner_id, c.kind, c.status, c.commission_pence, c.net_amount_pence, c.rate_bps, c.cost_deduction_bps, c.stripe_invoice_id,
               c.available_at, c.created_at, c.paid_at, c.void_reason, c.note, c.payout_batch_id,
               COALESCE(u.email, p.applicant_email) AS email,
               NULLIF(TRIM(COALESCE(u.first_name, p.applicant_name, '') || ' ' || COALESCE(u.last_name, '')), '') AS name
          FROM partner_commissions c JOIN partners p ON p.id = c.partner_id LEFT JOIN users u ON u.id = p.user_id
         WHERE (${st}::text IS NULL OR c.status = ${st})
         ORDER BY c.created_at DESC LIMIT ${Math.min(500, Math.max(1, limit))}`)) as unknown as Row[];
}

