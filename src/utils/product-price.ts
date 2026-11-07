// src/utils/product-price.ts — a product's price, recorded ONCE in Business Information and reused
// everywhere (db/z-product-pricing.sql). PURE. tests/product-price.test.ts.
//
//   fixed       £24 (optionally "per hour")      — the only kind that can be bought online
//   from        from £450                         — shown, never charged
//   on_request  Price on request
//   text        the owner's own words ("£15/month, first month free") — shown exactly
//   null        no price: assistants never state one
//
// The amount is in minor units (pence / cents) of `priceCurrency` (db/z-product-price-currency.sql):
// GBP, USD, EUR, AUD or CAD. Every older row is GBP. A fixed price in any of them can be bought online
// (Stripe charges in that currency); deposits are taken in GBP only — bookings store no currency.
//
// `org_products.price` is the DISPLAYED wording, derived here on every save, so every prompt that
// already quotes it (org-products.ts) keeps quoting exactly what the owner sees.

export type PriceType = 'fixed' | 'from' | 'on_request' | 'text';
export const PRICE_TYPES: readonly PriceType[] = ['fixed', 'from', 'on_request', 'text'];

/** Minor units (pence / cents). 30p is Stripe's sterling minimum for a charge; a fixed price below it is shown but not sold. */
export const PRICE_MAX_PENCE = 100_000_000;
export const BUY_MIN_PENCE = 30;
export const PRICE_UNIT_MAX = 30;

export type PriceCurrency = 'GBP' | 'USD' | 'EUR' | 'AUD' | 'CAD';
/** The currencies a price can be in — the editor's list, in this order. `buyMin` is Stripe's smallest charge. */
export const PRICE_CURRENCIES: Readonly<Record<PriceCurrency, { symbol: string; label: string; buyMin: number }>> = {
    GBP: { symbol: '£', label: 'Pounds (GBP)', buyMin: 30 },
    USD: { symbol: '$', label: 'US dollars (USD)', buyMin: 50 },
    EUR: { symbol: '€', label: 'Euros (EUR)', buyMin: 50 },
    AUD: { symbol: 'A$', label: 'Australian dollars (AUD)', buyMin: 50 },
    CAD: { symbol: 'C$', label: 'Canadian dollars (CAD)', buyMin: 50 },
};

/** A currency as sent ("usd", "GBP") → the stored code; null when it isn't one we take. */
export function cleanCurrency(v: unknown): PriceCurrency | null {
    const c = String(v ?? '').trim().toUpperCase();
    return Object.prototype.hasOwnProperty.call(PRICE_CURRENCIES, c) ? c as PriceCurrency : null;
}

export interface StructuredPrice {
    priceType: PriceType | null;
    priceAmount: number | null;
    priceUnit: string | null;
    /** The amount's currency; missing / null = GBP (every price before currencies). */
    priceCurrency?: string | null;
    /** For 'text': the owner's own wording. */
    priceText?: string | null;
}

/** 2400 → "£24", ("USD") → "$24", 2450 → "£24.50", 123456 → "£1,234.56". */
export function formatMoney(minor: number, currency?: string | null): string {
    const symbol = PRICE_CURRENCIES[cleanCurrency(currency) ?? 'GBP'].symbol;
    const major = minor / 100;
    return `${symbol}${Number.isInteger(major) ? major.toLocaleString('en-GB') : major.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Pounds only — deposits, and everything that was always sterling. */
export function formatPounds(pence: number): string {
    return formatMoney(pence, 'GBP');
}

/** An amount in MAJOR units (pounds / dollars), as typed or sent, in minor units:
 *  "24", "£24.50", "$24.50", "A$ 1,200", 24.5 → 2400 / 2450 / 2450 / 120000 / 2450. */
export function poundsToPence(raw: unknown): number | null {
    if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? Math.round(raw * 100) : null;
    const t = String(raw ?? '').replace(/^\s*(?:GBP|USD|EUR|AUD|CAD|US|AU|A|C)?\s*[£$€]?/i, '').replace(/[,\s]/g, '');
    if (!t || !/^\d+(\.\d{1,2})?$/.test(t)) return null;
    return Math.round(Number(t) * 100);
}

/** The displayed price — what customers, assistants and the site all show. Null = no price. */
export function priceDisplay(p: StructuredPrice): string | null {
    const unit = p.priceUnit ? ` ${p.priceUnit}` : '';
    switch (p.priceType) {
        case 'fixed': return p.priceAmount != null ? `${formatMoney(p.priceAmount, p.priceCurrency)}${unit}` : null;
        case 'from': return p.priceAmount != null ? `from ${formatMoney(p.priceAmount, p.priceCurrency)}${unit}` : null;
        case 'on_request': return 'Price on request';
        case 'text': return p.priceText?.trim() || null;
        default: return null;
    }
}

/** Whether a Buy button may be shown and charged: a fixed price Stripe can take, in minor units of its currency. */
export function buyablePence(p: { priceType: string | null; priceAmount: number | null; priceCurrency?: string | null }): number | null {
    const currency = p.priceCurrency == null ? 'GBP' : cleanCurrency(p.priceCurrency);
    if (!currency) return null;
    return p.priceType === 'fixed' && p.priceAmount != null && p.priceAmount >= PRICE_CURRENCIES[currency].buyMin && p.priceAmount <= PRICE_MAX_PENCE ? p.priceAmount : null;
}

/**
 * The price fields of a save, checked. `priceAmount` is in MAJOR units (pounds / dollars) — a string
 * or a number — and is stored in minor units of `priceCurrency` (GBP when not sent); `price` is the
 * owner's own wording for 'text'. Returns the columns to store, `price` (the display wording) included.
 */
export function cleanPrice(input: { priceType?: unknown; priceAmount?: unknown; priceUnit?: unknown; priceCurrency?: unknown; price?: unknown }):
    { error: string } | { priceType: PriceType | null; priceAmount: number | null; priceUnit: string | null; priceCurrency: PriceCurrency; price: string | null } {
    const type = input.priceType === null || input.priceType === '' || input.priceType === undefined ? null : String(input.priceType);
    if (type !== null && !PRICE_TYPES.includes(type as PriceType)) return { error: 'Choose how the price is shown.' };
    const sentCurrency = input.priceCurrency === null || input.priceCurrency === undefined || input.priceCurrency === '' ? 'GBP' : cleanCurrency(input.priceCurrency);
    if (!sentCurrency) return { error: 'Choose pounds, US dollars, euros, Australian dollars or Canadian dollars.' };
    const priceCurrency: PriceCurrency = sentCurrency;
    const unit = typeof input.priceUnit === 'string' && input.priceUnit.trim() ? input.priceUnit.replace(/\s+/g, ' ').trim().slice(0, PRICE_UNIT_MAX) : null;
    if (type === 'fixed' || type === 'from') {
        const amount = poundsToPence(input.priceAmount);
        if (amount === null || amount < 0 || amount > PRICE_MAX_PENCE) return { error: 'Enter the price as a number, e.g. 24 or 24.50.' };
        return { priceType: type, priceAmount: amount, priceUnit: unit, priceCurrency, price: priceDisplay({ priceType: type, priceAmount: amount, priceUnit: unit, priceCurrency }) };
    }
    if (type === 'on_request') return { priceType: type, priceAmount: null, priceUnit: null, priceCurrency, price: 'Price on request' };
    if (type === 'text') {
        const text = typeof input.price === 'string' ? input.price.trim().slice(0, 120) : '';
        if (!text) return { error: 'Write the price the way you want it shown.' };
        return { priceType: 'text', priceAmount: null, priceUnit: null, priceCurrency, price: text };
    }
    return { priceType: null, priceAmount: null, priceUnit: null, priceCurrency, price: null };
}

/** Symbols that name ONE currency. A bare "$" does not (US, Australian, Canadian…), so "$49" stays their words. */
const TEXT_SYMBOLS: Record<string, PriceCurrency> = { '£': 'GBP', '€': 'EUR', 'US$': 'USD', 'A$': 'AUD', 'AU$': 'AUD', 'C$': 'CAD', 'CA$': 'CAD' };

/** A written price read into the structured shape where it is simple ("£24", "from €450"); else 'text'. */
export function priceFromText(text: string | null | undefined): StructuredPrice {
    const t = String(text ?? '').trim();
    if (!t) return { priceType: null, priceAmount: null, priceUnit: null };
    const m = /^(from\s+)?(£|€|US\$|AU?\$|CA?\$)\s*(\d+(?:\.\d{1,2})?)$/i.exec(t);
    const currency = m ? TEXT_SYMBOLS[m[2].toUpperCase()] : undefined;
    if (m && currency) {
        return { priceType: m[1] ? 'from' : 'fixed', priceAmount: Math.round(Number(m[3]) * 100), priceUnit: null, ...(currency !== 'GBP' ? { priceCurrency: currency } : {}) };
    }
    return { priceType: 'text', priceAmount: null, priceUnit: null, priceText: t };
}

// ── Deposits (docs/booking-plan.md phase 4; db/z-booking-deposits.sql) ──────────────────────────
// Asked when the service (or class) is booked from the website, and paid on the business's own
// connected Stripe account. 'fixed' is pounds-as-typed → pence; 'percent' is of the FIXED price.

export type DepositType = 'fixed' | 'percent';

/** A deposit save, checked against the product's price as it will be stored. Amount in POUNDS for 'fixed'. */
export function cleanDeposit(input: { depositType?: unknown; depositAmount?: unknown }, price: { priceType: string | null; priceAmount: number | null; priceCurrency?: string | null }):
    { depositType: DepositType | null; depositAmount: number | null } | { error: string } {
    const t = input.depositType;
    if (t === null || t === undefined || t === '') return { depositType: null, depositAmount: null };
    // Bookings store a deposit in pence with no currency, so a deposit needs a price in pounds.
    if (price.priceCurrency && price.priceCurrency !== 'GBP') return { error: 'Deposits can only be taken in pounds for now. Set the price in pounds, or choose No deposit.' };
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
export function depositFor(p: { depositType: string | null; depositAmount: number | null; priceType: string | null; priceAmount: number | null; priceCurrency?: string | null }, places = 1): number | null {
    if (p.priceCurrency && p.priceCurrency !== 'GBP') return null;   // deposits are sterling only (cleanDeposit)
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
