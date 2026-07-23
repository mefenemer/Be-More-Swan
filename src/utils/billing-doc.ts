// src/utils/billing-doc.ts
// Shared look + voucher logic for the printable billing documents (invoice-pdf.ts, billing-receipt.ts).
//
// These docs are standalone HTML (opened in a tab / iframe), so they DON'T load the app's compiled
// Tailwind — the brand palette is inlined here as raw hex. Keep it in one place so the invoice and
// receipt stay visually identical and on-brand.
//
// Brand palette mirrors input.css (emerald tokens are remapped to Neon Pink there):
//   Neon Pink accent #ff007f / deep #d6006b / washes #fff0f5 #ffd6e8
//   Warm cream canvas #fdfcf9 / linen #f6f3eb / border #eae4d7
//   Espresso ink #1f1e1b / #2d2a23 / muted #5c564b #787263
//   Neon green (paid) #00b347

import type Stripe from 'stripe';

export const BMS = {
    pink: '#ff007f', pinkDeep: '#d6006b', pinkSoft: '#fff0f5', pinkBorder: '#ffd6e8',
    cream: '#fdfcf9', linen: '#f6f3eb', border: '#eae4d7',
    ink: '#1f1e1b', ink2: '#2d2a23', muted: '#5c564b', faint: '#787263',
    green: '#00b347',
} as const;

const CURRENCY_SYMBOL: Record<string, string> = { gbp: '£', usd: '$', eur: '€', aud: 'A$', cad: 'C$' };
export const currencySymbol = (c?: string | null) => CURRENCY_SYMBOL[(c || '').toLowerCase()] ?? '';
export const fmtMinor = (minor: number, currency: string) => `${currencySymbol(currency)}${(minor / 100).toFixed(2)}`;

export function esc(str: unknown): string {
    return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Voucher summary (shared with billing-data.ts) ────────────────────────────────
// Fold a Stripe subscription/invoice's discounts into a single display shape, in order (Stripe
// applies them sequentially). Percent + fixed coupons both resolve to the same shape. Null if none.
export interface VoucherSummary {
    codes: string[];
    name: string | null;
    label: string;            // e.g. "50% off" or "£10.00 off" (joined with " + " for stacked)
    grossAmount: number;      // major units, pre-discount
    discountAmount: number;   // major units covered by the voucher
    netAmount: number;        // major units left to pay
    percentCovered: number;
    duration: string | null;
    durationInMonths: number | null;
    endsAt: string | null;
    currency: string;
}

export function summariseDiscount(discounts: any[], grossMinor: number, currency: string): VoucherSummary | null {
    const active = (discounts || []).filter(d => d && typeof d === 'object' && d.coupon);
    if (!active.length || !(grossMinor > 0)) return null;

    let remaining = grossMinor;
    const parts: Array<{ code: string | null; name: string | null; label: string }> = [];
    let endsAt: string | null = null;
    let duration: string | null = null;
    let durationInMonths: number | null = null;

    for (const d of active) {
        const c = d.coupon;
        if (c.percent_off) {
            remaining -= Math.round(remaining * (c.percent_off / 100));
            parts.push({ code: d.promotion_code?.code ?? null, name: c.name ?? null, label: `${c.percent_off}% off` });
        } else if (c.amount_off) {
            remaining = Math.max(0, remaining - c.amount_off);
            parts.push({ code: d.promotion_code?.code ?? null, name: c.name ?? null, label: `${fmtMinor(c.amount_off, currency)} off` });
        } else {
            continue;
        }
        if (d.end) {
            const iso = new Date(d.end * 1000).toISOString();
            if (!endsAt || iso < endsAt) endsAt = iso;
        }
        if (!duration) { duration = c.duration ?? null; durationInMonths = c.duration_in_months ?? null; }
    }
    if (!parts.length) return null;

    const discountMinor = grossMinor - remaining;
    return {
        codes: parts.map(p => p.code).filter(Boolean) as string[],
        name: parts[0].name,
        label: parts.map(p => p.label).join(' + '),
        grossAmount: grossMinor / 100,
        discountAmount: discountMinor / 100,
        netAmount: remaining / 100,
        percentCovered: Math.round((discountMinor / grossMinor) * 1000) / 10,
        duration,
        durationInMonths,
        endsAt,
        currency,
    };
}

/**
 * Resolve the voucher applied to a specific Stripe invoice, for the printable docs. Best-effort:
 * returns null when Stripe isn't configured, the id is missing, or the call fails — the doc then
 * renders without a voucher line rather than erroring.
 */
export async function resolveInvoiceVoucher(stripe: Stripe | null, stripeInvoiceId: string | null | undefined): Promise<VoucherSummary | null> {
    if (!stripe || !stripeInvoiceId) return null;
    try {
        const inv = await stripe.invoices.retrieve(stripeInvoiceId, { expand: ['discounts.promotion_code'] }) as any;
        const grossMinor = typeof inv.subtotal === 'number' ? inv.subtotal : 0;
        return summariseDiscount(inv.discounts || [], grossMinor, inv.currency || 'gbp');
    } catch {
        return null;
    }
}

// ── Human phrasing for how long a voucher lasts / when the next full charge lands ────────────────
export function voucherDurationNote(v: VoucherSummary): string {
    if (v.duration === 'forever') return 'Applies for the life of this subscription.';
    if (v.duration === 'once') return 'Applied to this billing period only — the next renewal is at the full price.';
    if (v.duration === 'repeating') {
        const n = v.durationInMonths;
        const months = n ? `${n} month${n === 1 ? '' : 's'}` : 'a limited period';
        const until = v.endsAt
            ? ` (until ${new Date(v.endsAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })})`
            : '';
        return `Applies for ${months}${until}, then renews at the full price.`;
    }
    return '';
}

// ── Shared BMS document chrome ───────────────────────────────────────────────────────────────────
// One <style> block + a branded header, used by both the invoice and the receipt so they read as one
// system. `logoUrl` points at the same-origin brand asset; it sits on a white plate because the swan
// mark is pink and would vanish on the pink header.
export function bmsDocCss(accentStatusColor: string): string {
    return `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: ${BMS.cream}; color: ${BMS.ink}; font-size: 14px; line-height: 1.55; -webkit-font-smoothing: antialiased; }
  .page { max-width: 720px; margin: 40px auto; background: #fff; border-radius: 18px; box-shadow: 0 10px 40px rgba(214,0,107,.10); overflow: hidden; border: 1px solid ${BMS.border}; }

  .header { background: linear-gradient(135deg, ${BMS.pink} 0%, ${BMS.pinkDeep} 100%); padding: 32px 40px; color: #fff; display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; }
  .brand { display: flex; align-items: center; gap: 14px; }
  .brand .plate { background: #fff; border-radius: 12px; padding: 8px 10px; display: flex; align-items: center; box-shadow: 0 2px 8px rgba(0,0,0,.12); }
  .brand .plate img { height: 30px; width: auto; display: block; }
  .brand .name { font-size: 21px; font-weight: 800; letter-spacing: -0.4px; line-height: 1.1; }
  .brand .name small { display: block; font-size: 10.5px; font-weight: 600; letter-spacing: .06em; opacity: .8; margin-top: 3px; text-transform: uppercase; }
  .meta { text-align: right; }
  .meta .eyebrow { font-size: 10.5px; text-transform: uppercase; letter-spacing: .1em; opacity: .8; }
  .meta .num { font-size: 20px; font-weight: 800; margin-top: 2px; }
  .meta .date { font-size: 12.5px; opacity: .9; margin-top: 4px; }
  .status-badge { display: inline-block; margin-top: 8px; padding: 4px 12px; border-radius: 999px; font-size: 11px; font-weight: 800; letter-spacing: .06em; color: #fff; background: ${accentStatusColor}; }

  .body { padding: 34px 40px; }
  .section { margin-bottom: 26px; }
  .section-title { font-size: 10.5px; font-weight: 800; text-transform: uppercase; letter-spacing: .1em; color: ${BMS.pink}; margin-bottom: 12px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; }
  .addr-name { font-size: 15px; font-weight: 700; color: ${BMS.ink}; margin-bottom: 4px; }
  .addr-detail { color: ${BMS.muted}; font-size: 13px; line-height: 1.7; }

  .row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid ${BMS.linen}; font-size: 14px; }
  .row:last-child { border-bottom: none; }
  .row .label { color: ${BMS.faint}; }
  .row .value { font-weight: 600; color: ${BMS.ink}; text-align: right; }

  /* Voucher callout — the on-brand highlight for an applied discount */
  .voucher { margin-top: 6px; background: ${BMS.pinkSoft}; border: 1px solid ${BMS.pinkBorder}; border-radius: 12px; padding: 14px 16px; }
  .voucher .v-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .voucher .v-tag { font-size: 11px; font-weight: 800; letter-spacing: .04em; color: #fff; background: ${BMS.pink}; padding: 2px 9px; border-radius: 999px; text-transform: uppercase; }
  .voucher .v-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 700; color: ${BMS.pinkDeep}; font-size: 13px; }
  .voucher .v-line { display: flex; justify-content: space-between; font-size: 13.5px; color: ${BMS.ink2}; padding: 3px 0; }
  .voucher .v-line .v-amt { font-weight: 700; color: ${BMS.pinkDeep}; }
  .voucher .v-note { font-size: 12px; color: ${BMS.muted}; margin-top: 6px; }

  table.items { width: 100%; border-collapse: collapse; }
  table.items thead tr { border-bottom: 1px solid ${BMS.border}; }
  table.items th { padding: 8px 0; text-align: left; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: .06em; color: ${BMS.faint}; }
  table.items th:last-child, table.items td:last-child { text-align: right; }
  table.items tbody tr { border-bottom: 1px solid ${BMS.linen}; }
  table.items td { padding: 12px 0; font-size: 14px; color: ${BMS.ink2}; }
  table.items td:last-child { font-weight: 600; color: ${BMS.ink}; }
  .muted-note { font-size: 12px; color: ${BMS.faint}; margin-top: 2px; }

  .totals { margin-left: auto; width: 300px; margin-top: 8px; }
  .totals .t-row { display: flex; justify-content: space-between; padding: 7px 0; font-size: 14px; border-bottom: 1px solid ${BMS.linen}; }
  .totals .t-row.discount .t-val { color: ${BMS.pinkDeep}; font-weight: 700; }
  .totals .t-row .t-label { color: ${BMS.faint}; }
  .totals .t-row .t-val { font-weight: 600; color: ${BMS.ink}; }
  .totals .t-total { display: flex; justify-content: space-between; align-items: center; margin-top: 10px; padding: 14px 0; border-top: 2px solid ${BMS.pink}; }
  .totals .t-total .t-label { font-size: 15px; font-weight: 800; }
  .totals .t-total .t-val { font-size: 25px; font-weight: 800; color: ${BMS.pinkDeep}; }

  .footer { background: ${BMS.linen}; border-top: 1px solid ${BMS.border}; padding: 20px 40px; display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; }
  .footer p { font-size: 12px; color: ${BMS.faint}; }
  .footer a { color: ${BMS.pink}; text-decoration: none; font-weight: 700; }
  .print-btn { background: ${BMS.pink}; color: #fff; border: none; padding: 9px 18px; border-radius: 10px; font-size: 13px; font-weight: 800; cursor: pointer; }
  .print-btn:hover { background: ${BMS.pinkDeep}; }

  @media print {
    body { background: #fff; }
    .page { box-shadow: none; margin: 0; border-radius: 0; max-width: 100%; border: none; }
    .no-print { display: none !important; }
    .header, .status-badge, .voucher, .totals .t-total { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }`;
}

export function bmsHeader(opts: { logoUrl: string; subtitle?: string; metaHtml: string }): string {
    return `
  <div class="header">
    <div class="brand">
      <div class="plate"><img src="${esc(opts.logoUrl)}" alt="Be More Swan"></div>
      <div class="name">Be More Swan${opts.subtitle ? `<small>${esc(opts.subtitle)}</small>` : ''}</div>
    </div>
    <div class="meta">${opts.metaHtml}</div>
  </div>`;
}

/** The pink voucher callout block, or '' when no voucher applies. `symbol` is the currency symbol. */
export function voucherCallout(v: VoucherSummary | null): string {
    if (!v) return '';
    const code = v.codes[0] ? `<span class="v-code">${esc(v.codes[0])}</span>` : '';
    const note = voucherDurationNote(v);
    return `
    <div class="voucher">
      <div class="v-head"><span class="v-tag">Voucher applied</span>${code}</div>
      <div class="v-line"><span>${esc(v.label)}${v.name ? ` — ${esc(v.name)}` : ''}</span><span class="v-amt">−${currencySymbol(v.currency)}${v.discountAmount.toFixed(2)}</span></div>
      ${note ? `<div class="v-note">${esc(note)}</div>` : ''}
    </div>`;
}
