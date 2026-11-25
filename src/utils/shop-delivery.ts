// src/utils/shop-delivery.ts — UK delivery rates for the online shop (Phase 1, feature request #35,
// docs/online-shop-review-plan.md §6). tests/shop-delivery.test.ts.
//
// Up to 5 choices the buyer picks from on Stripe's checkout page: the business's own rates ("Royal Mail
// Tracked 48 — £3.95"), each optionally free over an order total, plus "Collect in person" if they offer it.
// Flat per order in this first version (no weight bands yet). Stored under a zone (only `uk` for now) so
// Phase 3 can add EU/US zones without reshaping: shop_settings.delivery = { zones: { uk: DeliverySetup } }.
//
// Delivery prices are in POUNDS (UK only), so they are offered only when every line of the basket is priced in
// pounds (deliveryApplies): Stripe refuses a checkout whose items and delivery are in different currencies.
//
// Only for basket checkouts — i.e. workspaces with a Shopkeeper (owner decision 5); a website-only shop's
// one-product Buy keeps its delivery wording in the Delivery & returns text, as today.
// Set from the Shopkeeper's Shop tab and its chat card `delivery_rates` (shop.ts delivery_rates).
//
// ⚠️ Raw SQL, columns kept out of db/schema.ts (db/z-shop-delivery.sql): a missing column = no rates, and
// checkout works exactly as before.

import { sql } from 'drizzle-orm';
import type Stripe from 'stripe';
import type { getDb } from '../../db/client';
import { formatMoney } from './product-price';

type Db = ReturnType<typeof getDb>;

export const MAX_DELIVERY_OPTIONS = 5;          // Stripe Checkout's own limit on shipping options
export const DELIVERY_NAME_MAX = 50;
export const DELIVERY_DAYS_MAX = 40;
export const COLLECT_NOTE_MAX = 120;
export const DELIVERY_PRICE_MAX = 50_000;        // pence: £500, the most a delivery choice or a free-over amount can be
export const ZONE = 'uk';

export interface DeliveryRate {
    name: string;
    /** Pence. 0 = free. */
    price: number;
    /** Free when the order's items come to at least this (pence); null = never free. */
    freeOver: number | null;
    /** "2–3 working days" — shown beside the name. */
    days: string | null;
}
export interface DeliverySetup { rates: DeliveryRate[]; collect: { on: boolean; note: string | null } }
export const NO_DELIVERY: DeliverySetup = { rates: [], collect: { on: false, note: null } };

export interface DeliveryInput { rates?: unknown; collect?: unknown }
type Parsed = { ok: true; value: DeliverySetup } | { ok: false; error: string };

const oneLine = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** "3.95", "£3.95", 3.95 → 395; "" → null. Pure. */
function pounds(v: unknown): number | null | 'bad' {
    if (v === null || v === undefined || (typeof v === 'string' && !v.trim())) return null;
    const t = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.replace(/[£,\s]/g, '') : '';
    if (!/^\d+(\.\d{1,2})?$/.test(t)) return 'bad';
    const p = Math.round(Number(t) * 100);
    return p > DELIVERY_PRICE_MAX ? 'bad' : p;
}

/** A whole delivery set-up from the Shop tab or the chat card, checked. It REPLACES the old one. Pure. */
export function parseDeliveryInput(raw: DeliveryInput): Parsed {
    const rates: DeliveryRate[] = [];
    if (raw?.rates !== undefined && !Array.isArray(raw.rates)) return { ok: false, error: 'rates must be a list (an empty list removes them).' };
    const seen = new Set<string>();
    for (const [i, r] of ((raw?.rates as Record<string, unknown>[]) ?? []).entries()) {
        const name = oneLine(r?.name, DELIVERY_NAME_MAX + 1);
        if (!name) return { ok: false, error: `Delivery choice ${i + 1} needs a name (e.g. "Royal Mail Tracked 48").` };
        if (name.length > DELIVERY_NAME_MAX) return { ok: false, error: `"${name.slice(0, 20)}…" is too long: at most ${DELIVERY_NAME_MAX} characters.` };
        if (seen.has(name.toLowerCase())) return { ok: false, error: `"${name}" is listed twice.` };
        seen.add(name.toLowerCase());
        const price = pounds(r?.price);
        if (price === 'bad' || price === null) return { ok: false, error: `"${name}": the price must be an amount like 3.95 (0 for free), up to £${DELIVERY_PRICE_MAX / 100}.` };
        const freeOver = pounds(r?.freeOver);
        if (freeOver === 'bad') return { ok: false, error: `"${name}": "free over" must be an amount like 40, or left empty.` };
        const days = oneLine(r?.days, DELIVERY_DAYS_MAX + 1);
        if (days.length > DELIVERY_DAYS_MAX) return { ok: false, error: `"${name}": how long it takes can be at most ${DELIVERY_DAYS_MAX} characters.` };
        rates.push({ name, price, freeOver: freeOver && freeOver > 0 && price > 0 ? freeOver : null, days: days || null });
    }
    const c = (raw?.collect && typeof raw.collect === 'object' ? raw.collect : {}) as Record<string, unknown>;
    const collect = { on: c.on === true || c.on === 'true' || c.on === 'on', note: oneLine(c.note, COLLECT_NOTE_MAX) || null };
    if (rates.length + (collect.on ? 1 : 0) > MAX_DELIVERY_OPTIONS) {
        return { ok: false, error: `Up to ${MAX_DELIVERY_OPTIONS} choices in all${collect.on ? ', counting "Collect in person"' : ''} (Stripe's limit).` };
    }
    return { ok: true, value: { rates, collect } };
}

export const hasDelivery = (s: DeliverySetup | null | undefined): s is DeliverySetup => !!s && (s.rates.length > 0 || s.collect.on);

/** Whether the delivery choices go with this basket: set up, and every line priced in pounds. Pure. */
export const deliveryApplies = (s: DeliverySetup | null | undefined, lines: { currency: string }[]): s is DeliverySetup =>
    hasDelivery(s) && lines.length > 0 && lines.every((l) => String(l.currency).toUpperCase() === 'GBP');

export interface DeliveryOption { name: string; amount: number; days: string | null; collect?: boolean }

/** The choices for an order whose items come to `subtotal` pence: a rate is free at or over its threshold. Pure. */
export function deliveryOptionsFor(s: DeliverySetup, subtotal: number): DeliveryOption[] {
    const out: DeliveryOption[] = s.rates.map((r) => {
        const free = r.freeOver != null && subtotal >= r.freeOver;
        return { name: free ? `${r.name} (free over ${formatMoney(r.freeOver!, 'GBP')})` : r.name, amount: free ? 0 : r.price, days: r.days };
    });
    if (s.collect.on) out.push({ name: s.collect.note ? `Collect in person: ${s.collect.note}` : 'Collect in person', amount: 0, days: null, collect: true });
    return out.slice(0, MAX_DELIVERY_OPTIONS);
}

/**
 * Stripe Checkout's shipping_options for those choices. Stripe pre-selects the FIRST, so the delivery rates come
 * first, cheapest first, and "Collect in person" always last: a buyer who doesn't notice the choice is never
 * defaulted into collection while giving a home address. Pure.
 */
export function stripeShippingOptions(options: DeliveryOption[]): Stripe.Checkout.SessionCreateParams.ShippingOption[] {
    const rates = options.filter((o) => !o.collect).sort((a, b) => a.amount - b.amount);
    return [...rates, ...options.filter((o) => o.collect)].map((o) => ({
        shipping_rate_data: {
            type: 'fixed_amount',
            display_name: (o.days ? `${o.name} · ${o.days}` : o.name).slice(0, 100),
            fixed_amount: { amount: o.amount, currency: 'gbp' },
            metadata: { bms_delivery: o.name.slice(0, 100) },
        },
    }));
}

/** "Royal Mail Tracked 48 £3.95 (free over £40) · Collect in person" — basket page, terms page, chat. Pure. */
export function deliveryWords(s: DeliverySetup): string {
    const parts = s.rates.map((r) => `${r.name} ${r.price === 0 ? 'free' : formatMoney(r.price, 'GBP')}${r.freeOver != null ? ` (free over ${formatMoney(r.freeOver, 'GBP')})` : ''}${r.days ? `, ${r.days}` : ''}`);
    if (s.collect.on) parts.push(s.collect.note ? `Collect in person (${s.collect.note})` : 'Collect in person');
    return parts.join(' · ');
}

/** The stored value → a clean set-up (anything odd dropped). Pure. */
export function setupFromStored(stored: unknown): DeliverySetup | null {
    const uk = (stored as { zones?: Record<string, unknown> } | null)?.zones?.[ZONE];
    if (!uk || typeof uk !== 'object') return null;
    const u = uk as { rates?: unknown; collect?: { on?: unknown; note?: unknown } };
    const parsed = parseDeliveryInput({
        rates: Array.isArray(u.rates) ? u.rates.map((r: Record<string, unknown>) => ({ ...r, price: Number(r?.price) / 100, freeOver: r?.freeOver == null ? '' : Number(r.freeOver) / 100 })) : [],
        collect: u.collect,
    });
    return parsed.ok ? parsed.value : null;
}

// ── Storage (raw SQL; missing column = no rates) ─────────────────────────────────────────────

export function isMissingDeliveryColumn(err: unknown): boolean {
    const e = err as { code?: string; cause?: { code?: string }; message?: string } | null;
    const code = e?.code ?? e?.cause?.code;
    return code === '42703' || /column "?(delivery|delivery_name|delivery_amount)"? does not exist/i.test(String(e?.message ?? ''));
}
const asRows = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];

/** This workspace's UK delivery set-up, or null (none, or the column isn't there yet). Never throws. */
export async function loadDelivery(db: Db, orgId: number): Promise<DeliverySetup | null> {
    try {
        const [r] = asRows<{ delivery: unknown }>(await db.execute(sql`SELECT delivery FROM shop_settings WHERE organisation_id = ${orgId}`));
        return r ? setupFromStored(r.delivery) : null;
    } catch (err) {
        if (!isMissingDeliveryColumn(err)) console.error('[shop-delivery] read failed', err instanceof Error ? err.message : err);
        return null;
    }
}

export type SaveDeliveryResult = { ok: true; value: DeliverySetup } | { ok: false; status: 400 | 503; error: string };

/** Replace the UK set-up (shop.ts delivery_rates: the Shop tab and the chat card). Creates the shop row if needed. */
export async function saveDelivery(db: Db, orgId: number, raw: DeliveryInput): Promise<SaveDeliveryResult> {
    const parsed = parseDeliveryInput(raw);
    if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
    const stored = JSON.stringify({ zones: { [ZONE]: parsed.value } });
    try {
        await db.execute(sql`
            INSERT INTO shop_settings (organisation_id, delivery) VALUES (${orgId}, ${stored}::jsonb)
            ON CONFLICT (organisation_id) DO UPDATE SET delivery = EXCLUDED.delivery, updated_at = now()`);
    } catch (err) {
        if (isMissingDeliveryColumn(err)) return { ok: false, status: 503, error: 'Delivery rates aren\'t switched on yet. Please try again later.' };
        throw err;
    }
    return { ok: true, value: parsed.value };
}

/** A paid order: which delivery the buyer chose and what it cost (raw; a missing column is ignored). */
export async function recordOrderDelivery(db: Db, orderId: number, name: string | null, amount: number | null): Promise<void> {
    if (name == null && amount == null) return;
    try {
        await db.execute(sql`UPDATE site_orders SET delivery_name = ${name ? name.slice(0, 120) : null}, delivery_amount = ${amount}::int WHERE id = ${orderId}`);
    } catch (err) {
        if (!isMissingDeliveryColumn(err)) console.error('[shop-delivery] order delivery not saved', err instanceof Error ? err.message : err);
    }
}

/** The delivery an order chose, by id (the Shop tab). Never throws. */
export async function loadOrderDelivery(db: Db, orgId: number, orderIds: number[]): Promise<Record<number, { name: string | null; amount: number | null }>> {
    const ids = [...new Set(orderIds.filter((n) => Number.isInteger(n) && n > 0))];
    if (!ids.length) return {};
    try {
        const rows = asRows<{ id: number; delivery_name: string | null; delivery_amount: unknown }>(await db.execute(sql`
            SELECT id, delivery_name, delivery_amount FROM site_orders
             WHERE organisation_id = ${orgId} AND id IN (${sql.join(ids.map((n) => sql`${n}`), sql`, `)})
               AND (delivery_name IS NOT NULL OR delivery_amount IS NOT NULL)`));
        return Object.fromEntries(rows.map((r) => [Number(r.id), { name: r.delivery_name, amount: r.delivery_amount == null ? null : Number(r.delivery_amount) }]));
    } catch (err) {
        if (!isMissingDeliveryColumn(err)) console.error('[shop-delivery] order delivery read failed', err instanceof Error ? err.message : err);
        return {};
    }
}
