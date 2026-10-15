// src/utils/product-price.ts — a product's price, recorded ONCE in Business Information and reused
// everywhere (db/z-product-pricing.sql). PURE. tests/product-price.test.ts.
//
//   fixed       £24 (optionally "per hour")      — the only kind that can be bought online
//   from        from £450                         — shown, never charged
//   on_request  Price on request
//   text        the owner's own words ("£15/month, first month free") — shown exactly
//   null        no price: assistants never state one
//
// `org_products.price` is the DISPLAYED wording, derived here on every save, so every prompt that
// already quotes it (org-products.ts) keeps quoting exactly what the owner sees.

export type PriceType = 'fixed' | 'from' | 'on_request' | 'text';
export const PRICE_TYPES: readonly PriceType[] = ['fixed', 'from', 'on_request', 'text'];

/** Pence. 30p is Stripe's sterling minimum for a charge; a fixed price below it is shown but not sold. */
export const PRICE_MAX_PENCE = 100_000_000;
export const BUY_MIN_PENCE = 30;
export const PRICE_UNIT_MAX = 30;

export interface StructuredPrice {
    priceType: PriceType | null;
    priceAmount: number | null;
    priceUnit: string | null;
    /** For 'text': the owner's own wording. */
    priceText?: string | null;
}

/** 2400 → "£24", 2450 → "£24.50", 123456 → "£1,234.56". */
export function formatPounds(pence: number): string {
    const pounds = pence / 100;
    return `£${Number.isInteger(pounds) ? pounds.toLocaleString('en-GB') : pounds.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** POUNDS, as typed or sent, in pence: "24", "£24.50", "1,200", 24.5 → 2400 / 2450 / 120000 / 2450. */
export function poundsToPence(raw: unknown): number | null {
    if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? Math.round(raw * 100) : null;
    const t = String(raw ?? '').replace(/[£,\s]/g, '');
    if (!t || !/^\d+(\.\d{1,2})?$/.test(t)) return null;
    return Math.round(Number(t) * 100);
}

/** The displayed price — what customers, assistants and the site all show. Null = no price. */
export function priceDisplay(p: StructuredPrice): string | null {
    const unit = p.priceUnit ? ` ${p.priceUnit}` : '';
    switch (p.priceType) {
        case 'fixed': return p.priceAmount != null ? `${formatPounds(p.priceAmount)}${unit}` : null;
        case 'from': return p.priceAmount != null ? `from ${formatPounds(p.priceAmount)}${unit}` : null;
        case 'on_request': return 'Price on request';
        case 'text': return p.priceText?.trim() || null;
        default: return null;
    }
}

/** Whether a Buy button may be shown and charged: a fixed sterling price Stripe can take. */
export function buyablePence(p: { priceType: string | null; priceAmount: number | null }): number | null {
    return p.priceType === 'fixed' && p.priceAmount != null && p.priceAmount >= BUY_MIN_PENCE && p.priceAmount <= PRICE_MAX_PENCE ? p.priceAmount : null;
}

/**
 * The price fields of a save, checked. `priceAmount` is in POUNDS — a "£" string or a number — and
 * is stored in pence; `price` is the owner's own wording for 'text'. Returns the columns to store,
 * `price` (the display wording) included.
 */
export function cleanPrice(input: { priceType?: unknown; priceAmount?: unknown; priceUnit?: unknown; price?: unknown }):
    { error: string } | { priceType: PriceType | null; priceAmount: number | null; priceUnit: string | null; price: string | null } {
    const type = input.priceType === null || input.priceType === '' || input.priceType === undefined ? null : String(input.priceType);
    if (type !== null && !PRICE_TYPES.includes(type as PriceType)) return { error: 'Choose how the price is shown.' };
    const unit = typeof input.priceUnit === 'string' && input.priceUnit.trim() ? input.priceUnit.replace(/\s+/g, ' ').trim().slice(0, PRICE_UNIT_MAX) : null;
    if (type === 'fixed' || type === 'from') {
        const amount = poundsToPence(input.priceAmount);
        if (amount === null || amount < 0 || amount > PRICE_MAX_PENCE) return { error: 'Enter the price in pounds, e.g. 24 or 24.50.' };
        return { priceType: type, priceAmount: amount, priceUnit: unit, price: priceDisplay({ priceType: type, priceAmount: amount, priceUnit: unit }) };
    }
    if (type === 'on_request') return { priceType: type, priceAmount: null, priceUnit: null, price: 'Price on request' };
    if (type === 'text') {
        const text = typeof input.price === 'string' ? input.price.trim().slice(0, 120) : '';
        if (!text) return { error: 'Write the price the way you want it shown.' };
        return { priceType: 'text', priceAmount: null, priceUnit: null, price: text };
    }
    return { priceType: null, priceAmount: null, priceUnit: null, price: null };
}

/** A written price read into the structured shape where it is simple ("£24", "from £450"); else 'text'. */
export function priceFromText(text: string | null | undefined): StructuredPrice {
    const t = String(text ?? '').trim();
    if (!t) return { priceType: null, priceAmount: null, priceUnit: null };
    let m = /^£\s*(\d+(?:\.\d{1,2})?)$/.exec(t);
    if (m) return { priceType: 'fixed', priceAmount: Math.round(Number(m[1]) * 100), priceUnit: null };
    m = /^from\s+£\s*(\d+(?:\.\d{1,2})?)$/i.exec(t);
    if (m) return { priceType: 'from', priceAmount: Math.round(Number(m[1]) * 100), priceUnit: null };
    return { priceType: 'text', priceAmount: null, priceUnit: null, priceText: t };
}

// ── Deposits (docs/booking-plan.md phase 4; db/z-booking-deposits.sql) ──────────────────────────
// Asked when the service (or class) is booked from the website, and paid on the business's own
// connected Stripe account. 'fixed' is pounds-as-typed → pence; 'percent' is of the FIXED price.

export type DepositType = 'fixed' | 'percent';

/** A deposit save, checked against the product's price as it will be stored. Amount in POUNDS for 'fixed'. */
export function cleanDeposit(input: { depositType?: unknown; depositAmount?: unknown }, price: { priceType: string | null; priceAmount: number | null }):
    { depositType: DepositType | null; depositAmount: number | null } | { error: string } {
    const t = input.depositType;
    if (t === null || t === undefined || t === '') return { depositType: null, depositAmount: null };
    if (t === 'fixed') {
        const pence = poundsToPence(input.depositAmount);
        if (pence === null || pence < BUY_MIN_PENCE) return { error: 'A deposit must be at least 30p.' };
        if (price.priceType === 'fixed' && price.priceAmount != null && pence > price.priceAmount) return { error: 'The deposit can\'t be more than the price.' };
        return { depositType: 'fixed', depositAmount: Math.min(pence, PRICE_MAX_PENCE) };
    }
    if (t === 'percent') {
        const n = Number(String(input.depositAmount ?? '').replace('%', '').trim());
        if (!Number.isInteger(n) || n < 1 || n > 100) return { error: 'A deposit percentage is a whole number from 1 to 100.' };
        if (price.priceType !== 'fixed' || price.priceAmount == null) return { error: 'A percentage deposit needs a fixed price — or ask for a fixed amount instead.' };
        if (Math.round((price.priceAmount * n) / 100) < BUY_MIN_PENCE) return { error: 'That comes to less than 30p — the smallest amount that can be paid by card.' };
        return { depositType: 'percent', depositAmount: n };
    }
    return { error: 'Choose a fixed amount or a percentage.' };
}

/** The deposit for `places` (1 for an appointment), in pence — null when none is asked or it can't be charged. */
export function depositFor(p: { depositType: string | null; depositAmount: number | null; priceType: string | null; priceAmount: number | null }, places = 1): number | null {
    let each: number | null = null;
    if (p.depositType === 'fixed' && p.depositAmount != null) each = p.depositAmount;
    else if (p.depositType === 'percent' && p.depositAmount != null && p.priceType === 'fixed' && p.priceAmount != null) each = Math.round((p.priceAmount * p.depositAmount) / 100);
    if (each === null || each < BUY_MIN_PENCE) return null;
    const total = each * Math.max(1, places);
    return total <= PRICE_MAX_PENCE ? total : null;
}

/** "£10 deposit", "£5 deposit per place" — for the site and the editor. */
export function depositLabel(p: Parameters<typeof depositFor>[0], perPlace = false): string | null {
    const d = depositFor(p, 1);
    return d === null ? null : `${formatPounds(d)} deposit${perPlace ? ' per place' : ''}`;
}
