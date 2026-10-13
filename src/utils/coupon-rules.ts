// src/utils/coupon-rules.ts
// What a coupon created on Admin → Revenue → Coupons may be, and how it maps onto Stripe.
// Pure — no DB, no Stripe — so the rules are tested directly (tests/admin-coupons.test.ts).
//
// Stripe's own constraints, enforced here so the admin gets a plain message instead of a Stripe
// error halfway through a two-step create:
//   • a coupon is EITHER percent_off OR amount_off (with a currency), never both;
//   • duration 'repeating' needs duration_in_months, and the others must not have it;
//   • the discount and duration can NEVER change after creation — only name/metadata on the
//     coupon and `active` on the promotion code. So "edit" here is name, notes and active only.
//   • a promotion code is what the customer types; Stripe matches it case-insensitively, and we
//     store it upper-case.

export type CouponDuration = 'once' | 'repeating' | 'forever';

export interface CouponInput {
    name: string;
    code: string;
    notes: string | null;
    percentOff: number | null;
    amountOffPence: number | null;
    duration: CouponDuration;
    durationInMonths: number | null;
    maxRedemptions: number | null;
    redeemBy: Date | null;
}

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,29}$/;

const num = (v: unknown): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
};

/** Validate a create request. Every rule Stripe would reject is caught here first. */
export function validateCouponInput(body: Record<string, unknown>, now = new Date()): Validated<CouponInput> {
    const name = String(body.name ?? '').trim();
    if (!name) return { ok: false, error: 'Give the coupon a name.' };
    if (name.length > 40) return { ok: false, error: 'The name can be at most 40 characters (Stripe shows it on invoices).' };

    const code = String(body.code ?? '').trim().toUpperCase();
    if (!CODE_RE.test(code)) {
        return { ok: false, error: 'The code must be 3–30 characters: letters, numbers, - or _, starting with a letter or number.' };
    }

    const kind = body.discountType === 'amount' ? 'amount' : 'percent';
    const value = num(body.discountValue);
    if (value === null || Number.isNaN(value) || value <= 0) return { ok: false, error: 'Enter a discount greater than zero.' };
    let percentOff: number | null = null;
    let amountOffPence: number | null = null;
    if (kind === 'percent') {
        if (value > 100) return { ok: false, error: 'A percentage discount cannot be more than 100%.' };
        if (Math.round(value * 100) !== value * 100) return { ok: false, error: 'Use at most two decimal places for a percentage.' };
        percentOff = value;
    } else {
        amountOffPence = Math.round(value * 100);
        if (amountOffPence < 1) return { ok: false, error: 'The amount off must be at least 1p.' };
    }

    const duration = String(body.duration ?? '') as CouponDuration;
    if (!['once', 'repeating', 'forever'].includes(duration)) {
        return { ok: false, error: 'Choose how long the discount lasts: once, a number of months, or forever.' };
    }
    let durationInMonths: number | null = null;
    if (duration === 'repeating') {
        const m = num(body.durationInMonths);
        if (m === null || Number.isNaN(m) || !Number.isInteger(m) || m < 1 || m > 36) {
            return { ok: false, error: 'Enter how many months the discount lasts (1–36).' };
        }
        durationInMonths = m;
    }

    const mr = num(body.maxRedemptions);
    if (mr !== null && (Number.isNaN(mr) || !Number.isInteger(mr) || mr < 1)) {
        return { ok: false, error: 'The usage limit must be a whole number of at least 1, or left blank for no limit.' };
    }

    let redeemBy: Date | null = null;
    if (body.redeemBy) {
        redeemBy = new Date(String(body.redeemBy));
        if (Number.isNaN(redeemBy.getTime())) return { ok: false, error: 'The expiry date is not a valid date.' };
        if (redeemBy.getTime() <= now.getTime()) return { ok: false, error: 'The expiry date must be in the future.' };
    }

    const notes = String(body.notes ?? '').trim() || null;
    return { ok: true, value: { name, code, notes, percentOff, amountOffPence, duration, durationInMonths, maxRedemptions: mr, redeemBy } };
}

/** The Stripe coupon create params for a validated input. */
export function stripeCouponParams(c: CouponInput) {
    return {
        name: c.name,
        duration: c.duration,
        ...(c.duration === 'repeating' ? { duration_in_months: c.durationInMonths! } : {}),
        ...(c.percentOff != null ? { percent_off: c.percentOff } : { amount_off: c.amountOffPence!, currency: 'gbp' }),
        ...(c.maxRedemptions != null ? { max_redemptions: c.maxRedemptions } : {}),
        ...(c.redeemBy ? { redeem_by: Math.floor(c.redeemBy.getTime() / 1000) } : {}),
        metadata: { source: 'bms_admin_coupons' },
    };
}

/** The Stripe promotion code create params, once the coupon exists. */
export function stripePromotionCodeParams(c: CouponInput, stripeCouponId: string) {
    return {
        promotion: { type: 'coupon' as const, coupon: stripeCouponId },
        code: c.code,
        ...(c.maxRedemptions != null ? { max_redemptions: c.maxRedemptions } : {}),
        ...(c.redeemBy ? { expires_at: Math.floor(c.redeemBy.getTime() / 1000) } : {}),
        metadata: { source: 'bms_admin_coupons' },
    };
}

/** "30% off for 12 months", "£10 off once", "50% off forever" — the line the admin list shows. */
export function describeCoupon(c: { percentOff: number | string | null; amountOffPence: number | null; duration: string; durationInMonths: number | null }): string {
    const off = c.percentOff != null
        ? `${Number(c.percentOff)}% off`
        : `£${((c.amountOffPence ?? 0) / 100).toFixed(2).replace(/\.00$/, '')} off`;
    const how = c.duration === 'once' ? 'the first payment'
        : c.duration === 'forever' ? 'forever'
        : `for ${c.durationInMonths} month${c.durationInMonths === 1 ? '' : 's'}`;
    return `${off} ${how}`;
}

// ── Importing what already exists in Stripe ───────────────────────────────────────────────────────
// Coupons made in the Stripe dashboard before this screen existed (or by hand since) are invisible
// to it. These shapes are the minimum read from Stripe; the mapping is pure so it is tested.

export interface StripeCouponLite {
    id: string; name: string | null; percent_off: number | null; amount_off: number | null; currency: string | null;
    duration: 'once' | 'repeating' | 'forever'; duration_in_months: number | null;
    max_redemptions: number | null; redeem_by: number | null; valid: boolean; times_redeemed: number;
}
export interface StripePromoCodeLite {
    id: string; code: string; active: boolean; couponId: string | null;
    max_redemptions: number | null; expires_at: number | null; created: number; times_redeemed: number;
}

export interface ImportRow {
    name: string; code: string; notes: string;
    percentOff: string | null; amountOffPence: number | null; currency: string;
    duration: 'once' | 'repeating' | 'forever'; durationInMonths: number | null;
    maxRedemptions: number | null; redeemBy: Date | null;
    stripeCouponId: string; stripePromotionCodeId: string; isActive: boolean; createdAt: Date;
}

/**
 * One row per PROMOTION CODE the Coupons screen does not already hold (matched on the promotion
 * code id, so a second import adds nothing). A coupon with no promotion code cannot be typed at
 * checkout, so it is returned separately to be shown, not imported.
 */
export function planStripeImport(coupons: StripeCouponLite[], codes: StripePromoCodeLite[], knownPromotionCodeIds: Set<string>) {
    const rows: ImportRow[] = [];
    for (const p of codes) {
        if (knownPromotionCodeIds.has(p.id)) continue;
        const c = coupons.find((x) => x.id === p.couponId);
        if (!c) continue;
        rows.push({
            name: (c.name || p.code).slice(0, 40), code: p.code.toUpperCase(),
            notes: 'Imported from Stripe — made before or outside the Coupons screen.',
            percentOff: c.percent_off != null ? String(c.percent_off) : null,
            amountOffPence: c.percent_off == null ? c.amount_off : null,
            currency: (c.currency || 'gbp').toLowerCase(),
            duration: c.duration, durationInMonths: c.duration === 'repeating' ? c.duration_in_months : null,
            maxRedemptions: p.max_redemptions ?? c.max_redemptions,
            redeemBy: p.expires_at ? new Date(p.expires_at * 1000) : c.redeem_by ? new Date(c.redeem_by * 1000) : null,
            stripeCouponId: c.id, stripePromotionCodeId: p.id,
            isActive: p.active && c.valid, createdAt: new Date(p.created * 1000),
        });
    }
    const noCode = coupons.filter((c) => !codes.some((p) => p.couponId === c.id));
    return { rows, noCode };
}
