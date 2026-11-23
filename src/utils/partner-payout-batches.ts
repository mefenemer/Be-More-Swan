// src/utils/partner-payout-batches.ts
// Affiliate Partner Programme, step 6 — the admin ledger actions and the monthly payout run
// (docs/affiliate-partner-programme-plan.md §4.4–4.5). Used by admin-partners.ts (the screen) and,
// through action cards, the Partner Ops chat — one implementation for both.
//
// A payout run:
//   previewPayout  → who is due: approved, suspended or ended partners (they keep what they earned, Terms 7.3) who
//                    have accepted the CURRENT Partner Terms, with CONFIRMED payout details, whose ready-to-pay balance (refund adjustments included)
//                    reaches the minimum — or is paid anyway under Terms 1.3 4.2 / 7.3 (underMinimumReason). Everyone else is listed with the reason they're left out.
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
import { PARTNER_TERMS_VERSION } from '../config/partner-terms';
import { isUkVatRegistered, vatPenceFor } from './partner-statements';

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

/**
 * Partner Terms 1.3 — when a balance under the minimum is still paid:
 *   4.2  it has been ready to pay (the oldest ready row) for 6 months and is at least £10;
 *   7.3  the partnership has ended — any ready balance is paid at the next run.
 * Returns null when it's paid, or the reason it rolls over.
 */
export const SMALL_BALANCE_FLOOR_PENCE = 1000;
export const SMALL_BALANCE_WAIT_MONTHS = 6;
export function underMinimumReason(amountPence: number, minPence: number, status: string, oldestReadyAt: Date | null, now: Date = new Date()): string | null {
    if (amountPence >= minPence || status === 'ended') return null;
    if (amountPence >= SMALL_BALANCE_FLOOR_PENCE && oldestReadyAt) {
        const due = new Date(oldestReadyAt.getTime());
        due.setUTCMonth(due.getUTCMonth() + SMALL_BALANCE_WAIT_MONTHS);
        if (due.getTime() <= now.getTime()) return null;
    }
    return `Under the £${(minPence / 100).toFixed(0)} minimum — rolls over (paid once it has waited ${SMALL_BALANCE_WAIT_MONTHS} months and is £${SMALL_BALANCE_FLOOR_PENCE / 100}+, or when the partnership ends)`;
}

export interface PayoutPreviewLine {
    partnerId: number; name: string | null; email: string | null; method: string | null; payoutDisplay: string | null;
    /** Commission (excl. VAT). The minimum is checked against this. */
    amountPence: number;
    /** Terms 4.5(b): UK VAT added for a UK-VAT-registered partner; paid on top of amountPence. */
    vatPence: number;
    due: boolean; reason: string | null;
}

/** Who is due, and who isn't (and why). Ready-to-pay rows not already in a batch. */
export async function previewPayout(db: Db): Promise<{ minPayoutPence: number; lines: PayoutPreviewLine[]; totalDuePence: number; totalVatPence: number }> {
    const [settings] = await db.select({ min: partnerProgrammeSettings.minPayoutPence }).from(partnerProgrammeSettings).where(eq(partnerProgrammeSettings.id, 1)).limit(1);
    const min = settings?.min ?? 5000;
    const rows = (await db.execute(sql`
        SELECT p.id, p.status, p.terms_version, p.payout_method, p.payout_display, p.payout_details_confirmed_at, p.vat_registered, p.vat_number,
               COALESCE(u.email, p.applicant_email) AS email,
               NULLIF(TRIM(COALESCE(u.first_name, p.applicant_name, '') || ' ' || COALESCE(u.last_name, '')), '') AS name,
               SUM(c.commission_pence)::int AS amount,
               MIN(c.available_at) AS oldest_ready
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
            // Terms 8.1: earned commission is never held back to get a newer version accepted — any accepted
            // version is a contract. Only a partner who has never accepted any version waits (no contract, no payout).
            : !r.terms_version ? `Hasn’t accepted the Partner Terms (v${PARTNER_TERMS_VERSION}) — it waits until they do`
            : !r.payout_details_confirmed_at || !r.payout_display ? 'No confirmed payout details'
            : underMinimumReason(amount, min, r.status, r.oldest_ready ? new Date(r.oldest_ready) : null);
        return { partnerId: r.id, name: r.name, email: r.email, method: r.payout_method, payoutDisplay: r.payout_display, amountPence: amount, vatPence: vatPenceFor(amount, isUkVatRegistered(r)), due: !reason && amount > 0, reason: amount <= 0 && !reason ? 'Nothing to pay after refunds' : reason };
    });
    const due = lines.filter((l) => l.due);
    // totalDuePence = commission; UK VAT for VAT-registered partners is paid on top (Terms 4.5(b)).
    return { minPayoutPence: min, lines, totalDuePence: due.reduce((s, l) => s + l.amountPence, 0), totalVatPence: due.reduce((s, l) => s + l.vatPence, 0) };
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
 * Wise batch-file headers.
 * ✅ UK bank — CHECKED 2026-11-23 against Wise's "Send to bank accounts" template (GBP → GBP, local bank account,
 *    business), downloaded by the owner:
 *      name,recipientEmail,paymentReference,referenceNumber,receiverType,amountCurrency,amount,sourceCurrency,targetCurrency,sortCode,accountNumber
 *      "e.g. Batch Payment Recipient", …, "INSTITUTION","source","0.00","GBP","GBP",,
 *    So: referenceNumber is a column (optional, left blank); amountCurrency is "source" (the amount is what we
 *    send, in GBP — NOT the currency code); a business recipient is "INSTITUTION".
 *    A personal account is "PERSON" (template rows added 2026-11-23).
 * ⚠️ Not yet checked: the email template ("Send by email"). US columns: see below.
 *    Download those from wise.com/batch/templates and change them HERE if they differ.
 */
export const WISE_BANK_HEADERS = ['name', 'recipientEmail', 'paymentReference', 'referenceNumber', 'receiverType', 'amountCurrency', 'amount', 'sourceCurrency', 'targetCurrency', 'sortCode', 'accountNumber'];
/** amountCurrency: "source" = the amount is in the source currency (GBP), what we pay out. From Wise's template. */
export const WISE_AMOUNT_IN_SOURCE = 'source';
/** receiverType: "INSTITUTION" for a business, "PERSON" for a personal account — both from Wise's template
 *  (owner added a personal GBP and USD row, 2026-11-23). NOT "PRIVATE", which we had assumed. */
export const WISE_RECEIVER_BUSINESS = 'INSTITUTION';
export const WISE_RECEIVER_PERSON = 'PERSON';
export const WISE_EMAIL_HEADERS = ['name', 'recipientEmail', 'paymentReference', 'receiverType', 'amountCurrency', 'amount', 'sourceCurrency', 'targetCurrency'];
// ✅ US bank (ACH) recipients, paid in USD from a GBP balance — CHECKED 2026-11-23 against Wise's "Send to bank
// accounts" template with a GBP → USD, US bank account, business row (downloaded by the owner). Wise's header, exactly:
//   …,targetCurrency,sortCode,accountNumber,type,abartn,accountType,addressCountryCode,addressFirstLine,addressCity,addressState,addressPostCode
//   US row: sortCode blank, type "Aba", accountType "CHECKING", addressCountryCode "US", addressState "AL" (2 letters).
export const WISE_US_HEADERS = ['name', 'recipientEmail', 'paymentReference', 'referenceNumber', 'receiverType', 'amountCurrency', 'amount', 'sourceCurrency', 'targetCurrency',
    'sortCode', 'accountNumber', 'type', 'abartn', 'accountType', 'addressCountryCode', 'addressFirstLine', 'addressCity', 'addressState', 'addressPostCode'];
/** Wise's `type` for a US routing-number (ABA) account — from its template. */
export const WISE_US_ACCOUNT_TYPE = 'Aba';
// ✅ Euro bank accounts (IBAN), paid in EUR from a GBP balance — from Wise's template with GBP → EUR rows, business and
// personal, inside and outside the EU (downloaded by the owner 2026-11-23). Those rows fill only IBAN and BIC (BIC may be
// blank); the address columns stay empty. The template's header is the full combined one, so it is used here as is.
export const WISE_EUR_HEADERS = [...WISE_US_HEADERS, 'IBAN', 'BIC'];
export type ExportFormat = 'wise_bank' | 'wise_email' | 'wise_us' | 'wise_eur' | 'paypal';

const csvCell = (v: string) => /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
/** A spreadsheet treats a leading = + - @ as a formula; neutralise it (CSV injection). */
const safe = (v: string) => /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
const pounds = (p: number) => (p / 100).toFixed(2);
/** UK Faster Payments references are 18 characters. */
export const paymentReference = (batchId: number) => `BMS PARTNER ${batchId}`.slice(0, 18);

/** amountPence = commission (excl. VAT); vatPence = UK VAT paid on top for a UK-VAT-registered partner (Terms 4.5(b)). */
export interface BatchLine { partnerId: number; name: string; email: string; amountPence: number; vatPence?: number; details: PayoutDetails | null }

/** Each partner in the batch, with their decrypted payout details. Server-side only. */
export async function batchLines(db: Db, batchId: number): Promise<BatchLine[]> {
    const rows = (await db.execute(sql`
        SELECT c.partner_id, SUM(c.commission_pence)::int AS amount, p.vat_registered, p.vat_number,
               COALESCE(u.email, p.applicant_email) AS email,
               NULLIF(TRIM(COALESCE(u.first_name, p.applicant_name, '') || ' ' || COALESCE(u.last_name, '')), '') AS name
          FROM partner_commissions c JOIN partners p ON p.id = c.partner_id LEFT JOIN users u ON u.id = p.user_id
         WHERE c.payout_batch_id = ${batchId}
         GROUP BY c.partner_id, u.email, u.first_name, u.last_name, p.applicant_email, p.applicant_name, p.vat_registered, p.vat_number
         ORDER BY c.partner_id`)) as unknown as Row[];
    const out: BatchLine[] = [];
    for (const r of rows) {
        const amount = Number(r.amount);
        out.push({ partnerId: r.partner_id, name: r.name || r.email || `Partner ${r.partner_id}`, email: r.email || '', amountPence: amount, vatPence: vatPenceFor(amount, isUkVatRegistered(r)), details: await getPayoutDetails(db, r.partner_id) });
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
        // Terms 4.5(b): what is sent = commission + any UK VAT.
        const pay = l.amountPence + (l.vatPence ?? 0);
        if (format === 'wise_bank' && d.method === 'bank') {
            rows.push([d.accountName, l.email, ref, '', d.holderType === 'business' ? WISE_RECEIVER_BUSINESS : WISE_RECEIVER_PERSON, WISE_AMOUNT_IN_SOURCE, pounds(pay), 'GBP', 'GBP', d.sortCode, d.accountNumber]);
        } else if (format === 'wise_eur' && d.method === 'eu_bank') {
            // The amount is the GBP commission; Wise converts it and the partner receives EUR. 10 empty US/UK columns, then IBAN, BIC.
            rows.push([d.accountName, l.email, ref, '', d.holderType === 'business' ? WISE_RECEIVER_BUSINESS : WISE_RECEIVER_PERSON, WISE_AMOUNT_IN_SOURCE, pounds(pay), 'GBP', 'EUR',
                ...Array(WISE_US_HEADERS.length - 9).fill(''), d.iban, d.bic || '']);
        } else if (format === 'wise_us' && d.method === 'us_bank') {
            // The amount is the GBP commission; Wise converts it and the partner receives USD.
            rows.push([d.accountName, l.email, ref, '', d.holderType === 'business' ? WISE_RECEIVER_BUSINESS : WISE_RECEIVER_PERSON, WISE_AMOUNT_IN_SOURCE, pounds(pay), 'GBP', 'USD',
                '', d.accountNumber, WISE_US_ACCOUNT_TYPE, d.routingNumber, d.accountType === 'savings' ? 'SAVINGS' : 'CHECKING', 'US', d.addressLine, d.city, d.state, d.zip]);
        } else if (format === 'wise_email' && d.method === 'wise') {
            rows.push([l.name, d.email, ref, WISE_RECEIVER_PERSON, WISE_AMOUNT_IN_SOURCE, pounds(pay), 'GBP', 'GBP']);
        } else if (format === 'paypal' && d.method === 'paypal') {
            // PayPal Payouts upload: no header row; email, amount, currency, customer id, note, wallet.
            rows.push([d.email, pounds(pay), 'GBP', `P${l.partnerId}-B${batchId}`, 'Be More Swan partner commission', 'PAYPAL']);
        } else continue;
        total += pay;
    }
    const header = format === 'wise_bank' ? [WISE_BANK_HEADERS] : format === 'wise_email' ? [WISE_EMAIL_HEADERS] : format === 'wise_us' ? [WISE_US_HEADERS] : format === 'wise_eur' ? [WISE_EUR_HEADERS] : [];
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
               COUNT(DISTINCT c.partner_id) FILTER (WHERE p.payout_method = 'us_bank')::int AS us_bank_partners,
               COUNT(DISTINCT c.partner_id) FILTER (WHERE p.payout_method = 'eu_bank')::int AS eu_bank_partners,
               -- What the Wise files in this run pay out, in GBP: the owner pays from a GBP balance in Wise (decision
               -- 2026-11-23) and tops it up from EUR first, so the Payouts screen says how much.
               COALESCE(SUM(c.commission_pence) FILTER (WHERE p.payout_method IN ('bank', 'us_bank', 'eu_bank', 'wise')), 0)::int AS wise_total_pence,
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

