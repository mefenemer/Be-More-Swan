// src/utils/shop-settings.ts — what UK consumer law needs a buyer to see (online shop Phase 0, FR#35).
// docs/online-shop-review-plan.md §5–§6. db/z-shop-settings.sql. tests/shop-settings.test.ts.
//
// The business is the trader and merchant of record (site-shop.ts); we only draw what they tell us.
// Consumer Contracts Regulations 2013: before paying, a buyer must see the trader's name, geographic
// address and contact details, the delivery arrangements and the 14-day right to cancel (with the
// model cancellation form, and who pays return postage); after paying they must get the same in a
// durable form (the buyer email, site-shop.ts). Consumer Rights Act 2015: faulty goods.
//
// ONE rule ties it to selling: a site shows Buy buttons only while shopReady() is true (canSell in
// site-shop.ts), so nobody can take money without these pages in place.
//
// Every reader is wrapped: a database without z-shop-settings.sql reads as "not set up yet".

import { eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { shopSettings } from '../../db/schema';
import { esc, SHOP_TERMS_PATH } from './site-render';

export { SHOP_TERMS_PATH };

type Db = ReturnType<typeof getDb>;

/** Goods the law lets a trader exclude from the 14-day right to cancel (CCR 2013 reg. 28). */
export const RETURN_EXCEPTIONS = {
    personalised: 'Items made to your own specification or clearly personalised',
    perishable: 'Items that go off quickly, such as fresh food or flowers',
    sealed_hygiene: 'Sealed items that cannot be returned for health or hygiene reasons once unsealed',
    sealed_media: 'Sealed recordings or software once unsealed',
    mixed: 'Items that are mixed with other things after delivery and cannot be separated',
} as const;
export type ReturnException = keyof typeof RETURN_EXCEPTIONS;

export interface ShopSettings {
    traderName: string | null;
    traderAddress: string | null;
    contactEmail: string | null;
    contactPhone: string | null;
    vatNumber: string | null;
    deliveryText: string | null;
    returnsDays: number;
    returnPostage: 'buyer' | 'seller';
    exceptions: ReturnException[];
    extraTerms: string | null;
    updatedAt?: string | null;
}

export const EMPTY_SHOP_SETTINGS: ShopSettings = {
    traderName: null, traderAddress: null, contactEmail: null, contactPhone: null, vatNumber: null,
    deliveryText: null, returnsDays: 14, returnPostage: 'buyer', exceptions: [], extraTerms: null, updatedAt: null,
};

/** The fields a buyer must see before paying — in the order the form asks for them. */
export const REQUIRED_FIELDS: { key: keyof ShopSettings; label: string }[] = [
    { key: 'traderName', label: 'Business or trading name' },
    { key: 'traderAddress', label: 'Business address' },
    { key: 'contactEmail', label: 'Email for customers' },
    { key: 'deliveryText', label: 'How and when you deliver' },
];

export const LIMITS = { name: 120, address: 400, email: 200, phone: 40, vat: 20, delivery: 600, extra: 2000 } as const;

/** What still needs filling in before Buy buttons can show (empty = ready). */
export function missingFields(s: ShopSettings | null): string[] {
    const v = s ?? EMPTY_SHOP_SETTINGS;
    return REQUIRED_FIELDS.filter((f) => !String(v[f.key] ?? '').trim()).map((f) => f.label);
}

export function shopReady(s: ShopSettings | null): boolean {
    return missingFields(s).length === 0;
}

const clean = (v: unknown, max: number): string | null => {
    if (typeof v !== 'string') return null;
    const t = v.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
    return t ? t.slice(0, max) : null;
};
const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;

export type SettingsInput = Partial<Record<keyof ShopSettings, unknown>>;
export type CleanResult = { ok: true; value: ShopSettings } | { ok: false; error: string };

/**
 * Merge an edit onto the saved settings and check it. Only the keys present in `input` change, so the
 * chat can set one field without wiping the rest. Same function for the form and the chat card.
 */
export function cleanSettings(base: ShopSettings | null, input: SettingsInput): CleanResult {
    const out: ShopSettings = { ...(base ?? EMPTY_SHOP_SETTINGS) };
    const has = (k: keyof ShopSettings) => Object.prototype.hasOwnProperty.call(input, k);
    if (has('traderName')) out.traderName = clean(input.traderName, LIMITS.name);
    if (has('traderAddress')) out.traderAddress = clean(input.traderAddress, LIMITS.address);
    if (has('contactPhone')) out.contactPhone = clean(input.contactPhone, LIMITS.phone);
    if (has('deliveryText')) out.deliveryText = clean(input.deliveryText, LIMITS.delivery);
    if (has('extraTerms')) out.extraTerms = clean(input.extraTerms, LIMITS.extra);
    if (has('vatNumber')) {
        const v = clean(input.vatNumber, LIMITS.vat);
        out.vatNumber = v ? v.toUpperCase().replace(/\s+/g, ' ') : null;
    }
    if (has('contactEmail')) {
        const e = clean(input.contactEmail, LIMITS.email);
        if (e && !EMAIL.test(e)) return { ok: false, error: 'That email address doesn\'t look right.' };
        out.contactEmail = e ? e.toLowerCase() : null;
    }
    if (has('returnsDays')) {
        const n = Number(input.returnsDays);
        if (!Number.isInteger(n) || n < 14 || n > 365) return { ok: false, error: 'Buyers must get at least 14 days to cancel (the law\'s minimum), and at most 365.' };
        out.returnsDays = n;
    }
    if (has('returnPostage')) {
        if (input.returnPostage !== 'buyer' && input.returnPostage !== 'seller') return { ok: false, error: 'Say who pays for return postage: the buyer or you.' };
        out.returnPostage = input.returnPostage;
    }
    if (has('exceptions')) {
        const list = Array.isArray(input.exceptions) ? input.exceptions : [];
        const bad = list.find((x) => typeof x !== 'string' || !(x in RETURN_EXCEPTIONS));
        if (bad !== undefined) return { ok: false, error: `"${String(bad)}" isn't one of the exceptions the law allows.` };
        out.exceptions = [...new Set(list as ReturnException[])];
    }
    return { ok: true, value: out };
}

function fromRow(r: typeof shopSettings.$inferSelect): ShopSettings {
    const ex = Array.isArray(r.exceptions) ? (r.exceptions as unknown[]).filter((x): x is ReturnException => typeof x === 'string' && x in RETURN_EXCEPTIONS) : [];
    return {
        traderName: r.traderName, traderAddress: r.traderAddress, contactEmail: r.contactEmail, contactPhone: r.contactPhone,
        vatNumber: r.vatNumber, deliveryText: r.deliveryText, returnsDays: r.returnsDays,
        returnPostage: r.returnPostage === 'seller' ? 'seller' : 'buyer', exceptions: ex, extraTerms: r.extraTerms,
        updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : null,
    };
}

/** The workspace's settings, or null when none are saved (or the table isn't there yet). */
export async function loadShopSettings(db: Db, orgId: number): Promise<ShopSettings | null> {
    try {
        const [row] = await db.select().from(shopSettings).where(eq(shopSettings.organisationId, orgId)).limit(1);
        return row ? fromRow(row) : null;
    } catch (err) {
        console.error('[shop-settings] read failed — treating the shop as not set up', err instanceof Error ? err.message : err);
        return null;
    }
}

/** Save an edit (owner/admin — the caller checks). Returns the saved settings or the reason it was refused. */
export async function saveShopSettings(db: Db, orgId: number, userId: number | null, input: SettingsInput): Promise<CleanResult> {
    const base = await loadShopSettings(db, orgId);
    const r = cleanSettings(base, input);
    if (!r.ok) return r;
    const v = r.value;
    const values = {
        traderName: v.traderName, traderAddress: v.traderAddress, contactEmail: v.contactEmail, contactPhone: v.contactPhone,
        vatNumber: v.vatNumber, deliveryText: v.deliveryText, returnsDays: v.returnsDays, returnPostage: v.returnPostage,
        exceptions: v.exceptions, extraTerms: v.extraTerms, updatedBy: userId, updatedAt: new Date(),
    };
    const [row] = await db.insert(shopSettings).values({ organisationId: orgId, ...values })
        .onConflictDoUpdate({ target: shopSettings.organisationId, set: values }).returning();
    return { ok: true, value: fromRow(row) };
}

// ── What the buyer reads ──────────────────────────────────────────────────────────────────────

const lines = (t: string) => t.split('\n').map((l) => esc(l)).join('<br>');
const para = (t: string) => t.split(/\n{2,}/).map((p) => `<p>${lines(p)}</p>`).join('');

/** "Who you're buying from" — trader details, for the page, the checkout note and the email. */
export function traderBlockHtml(s: ShopSettings): string {
    return `<p><strong>${esc(s.traderName || '')}</strong><br>${lines(s.traderAddress || '')}</p>`
        + `<p>Email: <a href="mailto:${esc(s.contactEmail || '')}">${esc(s.contactEmail || '')}</a>${s.contactPhone ? `<br>Phone: ${esc(s.contactPhone)}` : ''}${s.vatNumber ? `<br>VAT number: ${esc(s.vatNumber)}` : ''}</p>`;
}

/** The short version for the buyer's email: how long, who pays postage, what can't come back. */
export function returnsSummaryText(s: ShopSettings): string {
    const postage = s.returnPostage === 'seller' ? 'We pay for return postage.' : 'You pay for return postage.';
    const ex = s.exceptions.length ? ` This doesn't apply to: ${s.exceptions.map((e) => RETURN_EXCEPTIONS[e].toLowerCase()).join('; ')}.` : '';
    return `You can cancel within ${s.returnsDays} days of receiving your order, without giving a reason. ${postage}${ex}`;
}

/** The model cancellation form (CCR 2013 Schedule 3), addressed to this trader. */
export function cancellationFormHtml(s: ShopSettings): string {
    return `<div class="card"><p>To: ${esc(s.traderName || '')}, ${esc((s.traderAddress || '').replace(/\n+/g, ', '))}, ${esc(s.contactEmail || '')}</p>`
        + '<p>I/We hereby give notice that I/We cancel my/our contract of sale of the following goods:</p>'
        + '<p>Ordered on / received on:</p><p>Name of consumer(s):</p><p>Address of consumer(s):</p>'
        + '<p>Signature of consumer(s) (only if this form is sent on paper):</p><p>Date:</p>'
        + '<p class="fine">Delete as appropriate.</p></div>';
}

/** The whole Delivery & returns page body (site-serve.ts draws it in the site's own shell). */
export function shopTermsHtml(s: ShopSettings): string {
    const postage = s.returnPostage === 'seller'
        ? 'We pay the cost of sending the goods back to us.'
        : 'You pay the cost of sending the goods back to us.';
    const ex = s.exceptions.length
        ? `<h2>What can't be returned</h2><p>The right to cancel doesn't apply to:</p><ul>${s.exceptions.map((e) => `<li>${esc(RETURN_EXCEPTIONS[e])}</li>`).join('')}</ul><p>This doesn't affect your rights if an item is faulty.</p>`
        : '';
    return '<section><div class="w n">'
        + '<h1>Delivery &amp; returns</h1>'
        + `<h2>Who you're buying from</h2>${traderBlockHtml(s)}`
        + `<h2>Delivery</h2>${para(s.deliveryText || '')}<p>We deliver to addresses in the United Kingdom. Any delivery charge is shown before you pay.</p>`
        + `<h2>Your right to cancel</h2><p>You can cancel your order within ${s.returnsDays} days of the day you (or someone you name) receive the goods, without giving any reason. If your order arrives in several parts, the time runs from the day the last part arrives.</p>`
        + `<p>To cancel, tell us clearly — by email to <a href="mailto:${esc(s.contactEmail || '')}">${esc(s.contactEmail || '')}</a>, or by post to the address above. You can use the form below, but you don't have to.</p>`
        + `<p>Send the goods back within 14 days of telling us. ${postage}</p>`
        + '<p>We will refund what you paid, including the standard delivery charge, within 14 days of getting the goods back (or proof that you sent them, if sooner), to the card you paid with. We may take off an amount if the goods lost value because they were handled more than needed to see what they are and how they work.</p>'
        + ex
        + '<h2>Faulty items</h2><p>If an item is faulty, not as described or not fit for purpose, you can reject it for a full refund within 30 days of receiving it. After that you can ask for a repair or replacement, or a refund if that doesn\'t work. These are your rights under the Consumer Rights Act 2015, and nothing here takes them away.</p>'
        + (s.extraTerms ? `<h2>Other terms</h2>${para(s.extraTerms)}` : '')
        + '<h2>Payment</h2><p>Payments are taken securely by Stripe on our behalf. We never see your card details.</p>'
        + `<h2>Cancellation form</h2><p>Copy this into an email or letter if you'd like to use it.</p>${cancellationFormHtml(s)}`
        + '</div></section>';
}

/** One line for Stripe Checkout, beside the Pay button (plain text — Checkout shows it as it is). */
export function checkoutNote(s: ShopSettings, termsUrl: string): string {
    return `Sold by ${s.traderName}. ${returnsSummaryText(s)} Delivery & returns: ${termsUrl}`.slice(0, 1200);
}
