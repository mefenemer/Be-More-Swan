// src/utils/shop-options.ts — product options for the online shop (Phase 1, feature request #35,
// docs/online-shop-review-plan.md §6). tests/shop-options.test.ts.
//
// One group of choices per product ("Size": Small / Large), stored in product_options (db/z-shop-options.sql).
// Each option may carry its own price (else the product's) and its own stock (else not tracked).
//   - A product with active options is bought BY OPTION only: its card says "Choose an option" and links
//     to its page (site-product-page.ts), where each option has its own Buy button and price — no script,
//     and every button names the price it charges.
//   - Checkout (site-shop.ts) checks the option belongs to that product, charges ITS price, names the
//     order "Product — Option" and takes stock from the option when paid. The product's own stock is not
//     used while it has options.
// Set from the Shopkeeper's Shop tab and its chat card `product_options` — one server action (shop.ts).
//
// ⚠️ Raw SQL only, and a missing table reads as "no options" (code before the SQL works as today).
// db/schema.ts mirrors the table only so the workspace data export includes it.

import { sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { buyablePence, cleanCurrency, formatMoney, PRICE_CURRENCIES, PRICE_MAX_PENCE } from './product-price';
import { stockState, type StockState, STOCK_MAX } from './shop-stock';

type Db = ReturnType<typeof getDb>;

export const MAX_OPTIONS = 20;
export const OPTION_LABEL_MAX = 60;
export const OPTION_GROUP_MAX = 40;

export interface ProductOption {
    id: number;
    label: string;
    /** Minor units of the product's currency; null = the product's own price. */
    priceAmount: number | null;
    /** null = not tracked; 0 = sold out. */
    stock: number | null;
}

export interface ProductOptions { group: string; options: ProductOption[] }

/** The price an option charges: its own, else the product's. Null when it can't be bought online. Pure. */
export function optionPence(productPence: number | null, o: Pick<ProductOption, 'priceAmount'>, currency?: string | null): number | null {
    if (productPence == null) return null;   // the product itself must be sellable (a fixed price)
    if (o.priceAmount == null) return productPence;
    return buyablePence({ priceType: 'fixed', priceAmount: o.priceAmount, priceCurrency: currency ?? 'GBP' });
}

export const optionState = (o: Pick<ProductOption, 'stock'>): StockState => stockState(o.stock, null);

/** "House Blend — Large": the name on Stripe's page, the order and both emails. Pure. */
export function optionItemName(productName: string, label: string): string {
    return `${productName} — ${label}`.slice(0, 120);
}

/** A product with options is sold out only when every option is. Pure. */
export function allOptionsSoldOut(options: Pick<ProductOption, 'stock'>[]): boolean {
    return options.length > 0 && options.every((o) => o.stock != null && o.stock <= 0);
}

export interface OptionInput { id?: unknown; label?: unknown; price?: unknown; stock?: unknown }
type ParsedOption = { id: number | null; label: string; priceAmount: number | null; stock: number | null };
type Parsed = { ok: true; value: { group: string; options: ParsedOption[] } } | { ok: false; error: string };

/** "12.50", 12.5, "£12.50" → 1250 (minor units); "" / null → null (the product's price). */
function parsePrice(v: unknown, currency: string): { ok: true; value: number | null } | { ok: false } {
    if (v === null || v === undefined || v === '' || (typeof v === 'string' && !v.trim())) return { ok: true, value: null };
    const t = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.replace(/[£$€,\s]|CA\$|A\$/g, '') : '';
    if (!/^\d+(\.\d{1,2})?$/.test(t)) return { ok: false };
    const minor = Math.round(Number(t) * 100);
    const cur = cleanCurrency(currency) ?? 'GBP';
    if (minor < PRICE_CURRENCIES[cur].buyMin || minor > PRICE_MAX_PENCE) return { ok: false };
    return { ok: true, value: minor };
}

/**
 * The whole option list for one product, checked (the save REPLACES the list: options left out are
 * archived). An empty list removes the options. Prices are in major units, as Business Information takes
 * them. Pure.
 */
export function parseOptionsInput(raw: { group?: unknown; options?: unknown }, currency = 'GBP'): Parsed {
    const group = String(raw?.group ?? '').replace(/\s+/g, ' ').trim() || 'Option';
    if (group.length > OPTION_GROUP_MAX) return { ok: false, error: `The choice's name ("Size", "Colour"…) can be at most ${OPTION_GROUP_MAX} characters.` };
    if (!Array.isArray(raw?.options)) return { ok: false, error: 'options must be a list (an empty list removes them).' };
    if (raw.options.length > MAX_OPTIONS) return { ok: false, error: `At most ${MAX_OPTIONS} options per product.` };
    const seen = new Set<string>();
    const options: ParsedOption[] = [];
    for (const [i, o] of (raw.options as OptionInput[]).entries()) {
        const label = String(o?.label ?? '').replace(/\s+/g, ' ').trim();
        if (!label) return { ok: false, error: `Option ${i + 1} needs a name (e.g. "Large").` };
        if (label.length > OPTION_LABEL_MAX) return { ok: false, error: `"${label.slice(0, 20)}…" is too long: at most ${OPTION_LABEL_MAX} characters.` };
        const key = label.toLowerCase();
        if (seen.has(key)) return { ok: false, error: `"${label}" is listed twice.` };
        seen.add(key);
        const price = parsePrice(o?.price, currency);
        if (!price.ok) return { ok: false, error: `"${label}": the price must be an amount like 12.50 (at least ${formatMoney(PRICE_CURRENCIES[cleanCurrency(currency) ?? 'GBP'].buyMin, currency)}), or left empty for the product's price.` };
        let stock: number | null = null;
        if (!(o?.stock === null || o?.stock === undefined || o?.stock === '' || (typeof o?.stock === 'string' && !o.stock.trim()))) {
            const n = typeof o.stock === 'number' ? o.stock : typeof o.stock === 'string' && /^\s*\d+\s*$/.test(o.stock) ? Number(o.stock) : NaN;
            if (!Number.isInteger(n) || n < 0 || n > STOCK_MAX) return { ok: false, error: `"${label}": stock must be a whole number from 0 to ${STOCK_MAX.toLocaleString('en-GB')}, or left empty.` };
            stock = n;
        }
        const id = Number(o?.id);
        options.push({ id: Number.isInteger(id) && id > 0 ? id : null, label, priceAmount: price.value, stock });
    }
    return { ok: true, value: { group, options } };
}

/** Postgres "relation does not exist": db/z-shop-options.sql has not run on this database. */
export function isMissingOptionsTable(err: unknown): boolean {
    const e = err as { code?: string; cause?: { code?: string }; message?: string } | null;
    const code = e?.code ?? e?.cause?.code;
    return code === '42P01' || /relation "?product_options"? does not exist/i.test(String(e?.message ?? ''));
}

const asRows = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));
type Row = { id: number; product_id: number; group_name: string; label: string; price_amount: unknown; stock: unknown };

/** Active options of these products (this workspace's), keyed by product id. Never throws: no table → {}. */
export async function loadProductOptions(db: Db, orgId: number, productIds: number[]): Promise<Record<number, ProductOptions>> {
    const ids = [...new Set(productIds.filter((n) => Number.isInteger(n) && n > 0))];
    if (!ids.length) return {};
    try {
        const rows = asRows<Row>(await db.execute(sql`
            SELECT id, product_id, group_name, label, price_amount, stock FROM product_options
             WHERE organisation_id = ${orgId} AND status = 'active'
               AND product_id IN (${sql.join(ids.map((n) => sql`${n}`), sql`, `)})
             ORDER BY product_id, sort_order, id`));
        const out: Record<number, ProductOptions> = {};
        for (const r of rows) {
            const pid = Number(r.product_id);
            out[pid] ??= { group: r.group_name, options: [] };
            out[pid].options.push({ id: Number(r.id), label: r.label, priceAmount: numOrNull(r.price_amount), stock: numOrNull(r.stock) });
        }
        return out;
    } catch (err) {
        if (!isMissingOptionsTable(err)) console.error('[shop-options] read failed', err instanceof Error ? err.message : err);
        return {};
    }
}

export type SaveOptionsResult = { ok: true; value: ProductOptions } | { ok: false; status: 400 | 404 | 503; error: string };

/**
 * Replace a product's option list (shop.ts product_options: the Shop tab and the chat card). Options sent
 * with an id are updated (only this product's); new ones are added; active ones left out are archived
 * (never deleted: past orders name them). One transaction.
 */
export async function saveProductOptions(db: Db, orgId: number, productId: number, raw: { group?: unknown; options?: unknown }): Promise<SaveOptionsResult> {
    if (!Number.isInteger(productId) || productId <= 0) return { ok: false, status: 400, error: 'Which product? productId is missing.' };
    const [p] = asRows<{ price_currency: string | null }>(await db.execute(sql`
        SELECT price_currency FROM org_products WHERE id = ${productId} AND organisation_id = ${orgId} AND status = 'active'`));
    if (!p) return { ok: false, status: 404, error: 'That product isn\'t in this workspace\'s Business Information (or it is archived).' };
    const currency = p.price_currency || 'GBP';
    const parsed = parseOptionsInput(raw, currency);
    if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
    const { group, options } = parsed.value;
    try {
        await db.transaction(async (tx) => {
            const keep: number[] = [];
            for (const [i, o] of options.entries()) {
                if (o.id) {
                    const updated = asRows<{ id: number }>(await tx.execute(sql`
                        UPDATE product_options SET group_name = ${group}, label = ${o.label}, price_amount = ${o.priceAmount}::int,
                               stock = ${o.stock}::int, sort_order = ${i}, status = 'active', updated_at = now()
                         WHERE id = ${o.id} AND product_id = ${productId} AND organisation_id = ${orgId}
                     RETURNING id`));
                    if (updated[0]) { keep.push(Number(updated[0].id)); continue; }
                }
                const [ins] = asRows<{ id: number }>(await tx.execute(sql`
                    INSERT INTO product_options (organisation_id, product_id, group_name, label, price_amount, stock, sort_order)
                    VALUES (${orgId}, ${productId}, ${group}, ${o.label}, ${o.priceAmount}::int, ${o.stock}::int, ${i})
                 RETURNING id`));
                keep.push(Number(ins.id));
            }
            await tx.execute(sql`
                UPDATE product_options SET status = 'archived', updated_at = now()
                 WHERE product_id = ${productId} AND organisation_id = ${orgId} AND status = 'active'
                   ${keep.length ? sql`AND id NOT IN (${sql.join(keep.map((n) => sql`${n}`), sql`, `)})` : sql``}`);
        });
    } catch (err) {
        if (isMissingOptionsTable(err)) return { ok: false, status: 503, error: 'Product options aren\'t switched on yet. Please try again later.' };
        throw err;
    }
    const saved = (await loadProductOptions(db, orgId, [productId]))[productId];
    return { ok: true, value: saved ?? { group, options: [] } };
}

/** A paid order for an option: take `qty` from ITS stock, stopping at 0. Null when not tracked. */
export async function takeOptionStock(db: Db, orgId: number, optionId: number, qty: number): Promise<{ before: number; after: number; lowStockAt: null; oversold: boolean } | null> {
    if (!Number.isInteger(optionId) || optionId <= 0 || !(qty > 0)) return null;
    try {
        const [r] = asRows<{ before: unknown; after: unknown }>(await db.execute(sql`
            UPDATE product_options o SET stock = GREATEST(old.stock - ${Math.floor(qty)}::int, 0), updated_at = now()
              FROM (SELECT id, stock FROM product_options WHERE id = ${optionId} AND organisation_id = ${orgId} AND stock IS NOT NULL FOR UPDATE) old
             WHERE o.id = old.id
         RETURNING old.stock AS before, o.stock AS after`));
        if (!r) return null;
        const before = Number(r.before);
        return { before, after: Number(r.after), lowStockAt: null, oversold: before < qty };
    } catch (err) {
        if (isMissingOptionsTable(err)) return null;
        throw err;
    }
}

/** "Size: Small (£10, 4 left) · Large (£14, sold out)" — for the chat snapshot. Pure. */
export function optionsWords(po: ProductOptions, productPence: number | null, currency?: string | null): string {
    return `${po.group}: ${po.options.map((o) => {
        const pence = optionPence(productPence, o, currency);
        const st = optionState(o);
        const stock = st === 'untracked' ? '' : st === 'sold_out' ? ', sold out' : `, ${o.stock} left`;
        return `${o.label} [optionId ${o.id}] (${pence != null ? formatMoney(pence, currency || 'GBP') : 'no online price'}${stock})`;
    }).join(' · ')}`;
}
