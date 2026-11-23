// src/utils/partner-statements.ts
// Partner Terms 4.5 (cross-border review 2026-11-23): commission is stated EXCLUDING VAT. A partner registered for
// VAT in the UK (a GB… or XI… VAT number on their Partner page) is paid commission + UK VAT; anyone else is paid
// the commission and, for a partner outside the UK, we account for any UK VAT under the reverse charge.
// Every paid payout has a self-billed statement (their invoice under the self-billing agreement in 4.5(c)),
// which the partner opens from their Partner page (partner-hub.ts ?view=statement&batchId=N).

import { sql } from 'drizzle-orm';

type Db = any;
type Row = Record<string, any>;

export const UK_VAT_RATE_BPS = 2000;

/** Our details on every statement. */
export const BMS_STATEMENT_DETAILS = {
    name: 'Be More Swan Ltd',
    address: '167 - 169 Great Portland Street, 5th Floor, London, W1W 5PF, England',
    companyNumber: '17378263',
    // TODO(owner): add Be More Swan's VAT registration number here before the first VAT-registered partner is paid.
    // HMRC self-billing invoices must show the customer's (our) VAT number; none is recorded in the repo.
    vatNumber: null as string | null,
};

/** A UK VAT number: GB or XI, then 9 digits (or 12 for a group branch). Spaces and dashes are removed. */
export function normaliseVatNumber(raw: unknown): string | null {
    const v = String(raw ?? '').toUpperCase().replace(/[\s-]/g, '');
    if (!v) return null;
    return /^[A-Z]{2}[0-9A-Z]{2,13}$/.test(v) ? v : null;
}

export function isUkVatNumber(vatNumber: string | null | undefined): boolean {
    return !!vatNumber && /^(GB|XI)(\d{9}|\d{12})$/.test(vatNumber);
}

/** Terms 4.5(b): UK VAT is added only for a UK-VAT-registered partner. */
export function isUkVatRegistered(p: { vatRegistered?: boolean | null; vat_registered?: boolean | null; vatNumber?: string | null; vat_number?: string | null }): boolean {
    const registered = p.vatRegistered ?? p.vat_registered ?? false;
    return !!registered && isUkVatNumber(p.vatNumber ?? p.vat_number ?? null);
}

/** UK VAT on a commission amount, rounded to the penny (none for a non-UK-VAT partner, or a negative amount). */
export function vatPenceFor(commissionPence: number, ukVat: boolean): number {
    if (!ukVat || commissionPence <= 0) return 0;
    return Math.round((commissionPence * UK_VAT_RATE_BPS) / 10_000);
}

export const statementNumber = (batchId: number, partnerId: number) => `BMS-SB-${batchId}-${partnerId}`;

/** The partner's paid payouts, newest first — each has a statement. */
export async function listPartnerPayouts(db: Db, partnerId: number): Promise<Array<{ batchId: number; paidAt: string; commissionPence: number }>> {
    const rows = (await db.execute(sql`
        SELECT b.id AS batch_id, b.paid_at::text AS paid_at, SUM(c.commission_pence)::int AS amount
          FROM partner_commissions c JOIN partner_payout_batches b ON b.id = c.payout_batch_id
         WHERE c.partner_id = ${partnerId} AND b.status = 'paid'
         GROUP BY b.id, b.paid_at ORDER BY b.paid_at DESC LIMIT 60`)) as Row[];
    return rows.map((r) => ({ batchId: Number(r.batch_id), paidAt: String(r.paid_at), commissionPence: Number(r.amount) }));
}

export interface StatementData {
    number: string; date: string; partnerName: string; partnerEmail: string | null; vatNumber: string | null; ukVat: boolean;
    lines: Array<{ date: string; label: string; paymentPence: number | null; commissionPence: number }>;
    subtotalPence: number; vatPence: number; totalPence: number;
}

/** A partner's statement for one of THEIR paid batches, or null (not theirs / not paid). */
export async function loadStatement(db: Db, partnerId: number, batchId: number): Promise<StatementData | null> {
    const head = (await db.execute(sql`
        SELECT b.paid_at::text AS paid_at, v.vat_number AS frozen_vat_number, COALESCE(v.vat_pence, 0)::int AS frozen_vat_pence,
               COALESCE(u.email, p.applicant_email) AS email,
               NULLIF(TRIM(COALESCE(u.first_name, p.applicant_name, '') || ' ' || COALESCE(u.last_name, '')), '') AS name
          FROM partner_payout_batches b
          JOIN partners p ON p.id = ${partnerId}
          LEFT JOIN users u ON u.id = p.user_id
          LEFT JOIN partner_payout_vat v ON v.batch_id = b.id AND v.partner_id = p.id
         WHERE b.id = ${batchId} AND b.status = 'paid'`)) as Row[];
    if (!head.length) return null;
    const rows = (await db.execute(sql`
        SELECT c.kind, c.created_at::text AS created_at, c.net_amount_pence, c.commission_pence, c.note,
               (SELECT COUNT(*) FROM partner_referrals x WHERE x.partner_id = ${partnerId} AND x.id <= c.partner_referral_id)::int AS customer_no
          FROM partner_commissions c
         WHERE c.partner_id = ${partnerId} AND c.payout_batch_id = ${batchId}
         ORDER BY c.created_at`)) as Row[];
    if (!rows.length) return null;
    const h = head[0];
    // Review of #823: the VAT position frozen when the run was created, never the partner's current VAT number.
    const ukVat = !!h.frozen_vat_number;
    const lines = rows.map((r) => ({
        date: String(r.created_at).slice(0, 10),
        label: r.kind === 'invoice' ? `Commission — Customer ${r.customer_no}` : r.kind === 'bonus' ? `Bonus${r.note ? ` — ${r.note}` : ''}` : `Adjustment${r.note ? ` — ${r.note}` : ''}`,
        paymentPence: r.kind === 'invoice' ? Number(r.net_amount_pence) : null,
        commissionPence: Number(r.commission_pence),
    }));
    const subtotal = lines.reduce((s, l) => s + l.commissionPence, 0);
    const vat = Number(h.frozen_vat_pence) || 0;
    return {
        number: statementNumber(batchId, partnerId), date: String(h.paid_at).slice(0, 10),
        partnerName: h.name || h.email || `Partner ${partnerId}`, partnerEmail: h.email ?? null, vatNumber: h.frozen_vat_number ?? null, ukVat,
        lines, subtotalPence: subtotal, vatPence: vat, totalPence: subtotal + vat,
    };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const gbp = (p: number) => `£${(p / 100).toFixed(2)}`;

/** The printable statement. Pure — tested directly. */
export function statementHtml(s: StatementData): string {
    const b = BMS_STATEMENT_DETAILS;
    const vatNote = s.ukVat
        ? 'Self-billed invoice — the VAT shown is your output tax due to HMRC.'
        : 'Reverse charge: the customer accounts for any UK VAT. (If you are in the UK and not VAT-registered, no VAT is due.)';
    const rows = s.lines.map((l) => `<tr><td>${esc(l.date)}</td><td>${esc(l.label)}</td><td class="n">${l.paymentPence == null ? '' : gbp(l.paymentPence)}</td><td class="n">${gbp(l.commissionPence)}</td></tr>`).join('');
    return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Statement ${esc(s.number)}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;color:#111;max-width:760px;margin:24px auto;padding:0 16px}h1{font-size:20px;margin:0 0 4px}table{width:100%;border-collapse:collapse;margin:16px 0}td,th{padding:6px 4px;border-bottom:1px solid #e5e7eb;text-align:left}.n{text-align:right}.muted{color:#555}.tot td{font-weight:700}@media print{button{display:none}}</style></head><body>
<button onclick="window.print()">Print or save as PDF</button>
<h1>${s.ukVat ? 'Self-billed invoice' : 'Payout statement'} ${esc(s.number)}</h1>
<p class="muted">Date: ${esc(s.date)} · Partner commission under the Be More Swan Partner Terms</p>
<p><strong>From (supplier):</strong> ${esc(s.partnerName)}${s.vatNumber ? ` · VAT ${esc(s.vatNumber)}` : ''}<br><span class="muted">Self-billed by the customer under the agreement in Partner Terms 4.5.</span></p>
<p><strong>To (customer):</strong> ${esc(b.name)}, ${esc(b.address)} · Company number ${esc(b.companyNumber)}${b.vatNumber ? ` · VAT ${esc(b.vatNumber)}` : ''}</p>
<table><thead><tr><th>Date</th><th>Description</th><th class="n">Payment (excl. VAT)</th><th class="n">Commission</th></tr></thead><tbody>${rows}</tbody>
<tfoot><tr><td></td><td>Total excluding VAT</td><td></td><td class="n">${gbp(s.subtotalPence)}</td></tr>
${s.ukVat ? `<tr><td></td><td>UK VAT at 20%</td><td></td><td class="n">${gbp(s.vatPence)}</td></tr>` : ''}
<tr class="tot"><td></td><td>Total paid</td><td></td><td class="n">${gbp(s.totalPence)}</td></tr></tfoot></table>
<p>${esc(vatNote)}</p>
<p class="muted">Customers are shown by number only (Partner Terms 9.2). Questions: hello@bemoreswan.com.</p>
</body></html>`;
}
