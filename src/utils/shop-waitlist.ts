// src/utils/shop-waitlist.ts — "Tell me when it's back" (online shop Phase 2, slice 6; feature request #35,
// docs/online-shop-review-plan.md §12, owner Q4 2026-11-26: ask first). tests/shop-waitlist.test.ts,
// tests/shop-waitlist-db.test.ts.
//
// 1. A SOLD-OUT product's own page (a Shopkeeper workspace's site) shows an email box. Posting it (/_buy, _a=notify)
//    puts the address on that product's waiting list — once per person per product, rate-limited per visitor.
//    A service email they asked for, so it needs no marketing consent and NEVER adds them to the Audience.
// 2. When the owner's stock save makes the product buyable again (Shop tab or the chat's stock card — both go through
//    shop.ts) and people are waiting, the Shopkeeper asks in Team Chat: "Lavender candle is back — email the 6
//    people waiting?" [Email them] [Not now], with a link to ask the Social Media assistant for a post. Nothing is
//    sent without that click (or "Email the 6 waiting" on the Shop tab).
// 3. Sending: one email each, ONLY from the owner's verified sending domain or connected Gmail/Outlook
//    (resolveSendRoute) — never a Be More Swan sender. Every refusal in the shared consent check still applies
//    (unsubscribed, bounced, complained, outreach opt-out, suppressed domain, pause): those are skipped and marked.
//    At most SEND_BATCH per click, so one click fits in a function's time; the rest wait for the next click.
//
// ⚠️ Raw SQL on shop_waitlist (db/z-shop-waitlist.sql). Before it: no box on the page, nothing asked, no counts.

import { sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { checkAudienceConsentBulk } from './audience-consent';
import { looksLikeEmail, normaliseEmail } from './audience-contacts';
import { resolveSendRoute } from './newsletter-send';
import { deliverStep } from './newsletter-sequence';
import { siteOrigin } from './site-hosting';
import { productPagePath } from './site-product-page';

type Db = ReturnType<typeof getDb>;

/** The product page form's action value (posted to /_buy). Lives in shop-basket.ts so the page renderer stays light. */
export { WAITLIST_ACTION } from './shop-basket';
/** Waiting-list sign-ups a visitor may make in an hour. */
export const WAITLIST_LIMIT = { maxAttempts: 10, windowSecs: 3600 };
/** People on one product's list at most (a full list takes no more). */
export const WAITLIST_MAX_PER_PRODUCT = 2000;
/** Emails sent per click; the rest wait for the next click. */
export const SEND_BATCH = 40;

const asRows = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];
const numOrNull = (v: unknown) => (v == null ? null : Number(v));

/** db/z-shop-waitlist.sql (or the stock columns) isn't on this database yet. */
export function isMissingWaitlist(err: unknown): boolean {
    const e = err as { code?: string; cause?: { code?: string }; message?: string } | null;
    const code = e?.code ?? e?.cause?.code;
    return code === '42P01' || code === '42703' || /relation "?shop_waitlist"? does not exist/i.test(String(e?.message ?? ''));
}

/** Can the product be bought right now? The same rule the product page uses: options → any option left; else stock. Pure. */
export function buyableFrom(stock: number | null, options: Array<{ stock: number | null }>): boolean {
    if (options.length) return options.some((o) => o.stock == null || o.stock > 0);
    return stock == null || stock > 0;
}

/** Read whether a product can be bought now. Null when it isn't an active product here (or stock isn't switched on). */
export async function productBuyable(db: Db, orgId: number, productId: number): Promise<{ name: string; buyable: boolean } | null> {
    try {
        const [p] = asRows<{ name: string; stock: unknown }>(await db.execute(sql`
            SELECT name, stock FROM org_products WHERE id = ${productId} AND organisation_id = ${orgId} AND status = 'active'`));
        if (!p) return null;
        let options: Array<{ stock: number | null }> = [];
        try {
            options = asRows<{ stock: unknown }>(await db.execute(sql`
                SELECT stock FROM product_options WHERE product_id = ${productId} AND organisation_id = ${orgId} AND status = 'active'`)).map((o) => ({ stock: numOrNull(o.stock) }));
        } catch (err) {
            if (!isMissingWaitlist(err)) throw err;   // no options table yet: a product without options
        }
        return { name: p.name, buyable: buyableFrom(numOrNull(p.stock), options) };
    } catch (err) {
        if (isMissingWaitlist(err)) return null;
        throw err;
    }
}

export type JoinResult = { ok: true; already: boolean } | { ok: false; status: 400 | 404 | 409 | 503; error: string };

/** Put an address on a product's waiting list. The caller checked the site offers the product and rate-limited. */
export async function joinWaitlist(db: Db, o: { orgId: number; siteId: number; productId: number; email: unknown }): Promise<JoinResult> {
    const email = normaliseEmail(String(o.email ?? '').slice(0, 254));
    if (!email || !looksLikeEmail(email)) return { ok: false, status: 400, error: 'That email address doesn\'t look right. Go back and check it.' };
    const product = await productBuyable(db, o.orgId, o.productId);
    if (!product) return { ok: false, status: 404, error: 'That product isn\'t available here any more.' };
    if (product.buyable) return { ok: false, status: 409, error: 'Good news: it\'s back in stock now. Go back to buy it.' };
    try {
        const [count] = asRows<{ n: number }>(await db.execute(sql`
            SELECT count(*)::int AS n FROM shop_waitlist WHERE product_id = ${o.productId} AND organisation_id = ${o.orgId} AND notified_at IS NULL`));
        if (Number(count?.n) >= WAITLIST_MAX_PER_PRODUCT) return { ok: false, status: 409, error: 'The waiting list for this product is full. Please check back later.' };
        const rows = asRows<{ id: number }>(await db.execute(sql`
            INSERT INTO shop_waitlist (organisation_id, site_id, product_id, email) VALUES (${o.orgId}, ${o.siteId}, ${o.productId}, ${email})
            ON CONFLICT (product_id, lower(email)) WHERE notified_at IS NULL DO NOTHING RETURNING id`));
        return { ok: true, already: rows.length === 0 };
    } catch (err) {
        if (isMissingWaitlist(err)) return { ok: false, status: 503, error: 'This isn\'t switched on yet. Please check back later.' };
        throw err;
    }
}

/** How many are waiting, per product, in this workspace. {} before the SQL. Never throws. */
export async function waitingCounts(db: Db, orgId: number): Promise<Record<number, number>> {
    try {
        const rows = asRows<{ product_id: number; n: number }>(await db.execute(sql`
            SELECT product_id, count(*)::int AS n FROM shop_waitlist WHERE organisation_id = ${orgId} AND notified_at IS NULL GROUP BY product_id`));
        const out: Record<number, number> = {};
        for (const r of rows) out[Number(r.product_id)] = Number(r.n);
        return out;
    } catch (err) {
        if (!isMissingWaitlist(err)) console.error('[shop-waitlist] counts read failed', err instanceof Error ? err.message : err);
        return {};
    }
}

/** The Team Chat question. Pure. */
export function backInStockQuestion(name: string, waiting: number): string {
    return `${name} is back in stock. Email the ${waiting} ${waiting === 1 ? 'person' : 'people'} waiting to hear?`.slice(0, 1000);
}

export const BACK_IN_STOCK_CHOICES = [{ value: 'send', label: 'Email them' }, { value: 'later', label: 'Not now' }];

/**
 * After a stock save: the product went from sold out to buyable and people are waiting → the Shopkeeper asks in Team
 * Chat (once while a question for this product is open). Returns how many are waiting (0 = nothing asked). Never throws.
 */
export async function askBackInStock(db: Db, o: { orgId: number; productId: number; name: string; shopkeeperId: number | null }): Promise<number> {
    try {
        const waiting = (await waitingCounts(db, o.orgId))[o.productId] ?? 0;
        if (!waiting) return 0;
        const { postTeamMessage, openQuestionExists } = await import('./team-messages');
        if (await openQuestionExists(db, o.orgId, 'back_in_stock', o.productId)) return waiting;
        // The Social Media assistant, if there is an active one: a link to ask it for a post (its own chat).
        const [social] = asRows<{ id: number; name: string }>(await db.execute(sql`
            SELECT a.id, a.name FROM ai_assistants a JOIN master_assistants m ON m.id = a.master_assistant_id
             WHERE a.organisation_id = ${o.orgId} AND a.is_active AND a.archived_at IS NULL AND a.lifecycle_status <> 'archived' AND m.role_key = 'social_media_manager'
             ORDER BY a.id LIMIT 1`).catch(() => []));
        await postTeamMessage(db, {
            organisationId: o.orgId, fromAssistantId: o.shopkeeperId, toUser: true, kind: 'question',
            body: backInStockQuestion(o.name, waiting),
            question: { key: 'back_in_stock', ref: o.productId, choices: BACK_IN_STOCK_CHOICES },
            link: social ? { assistantId: Number(social.id), chat: true, label: `Ask ${social.name} for a post` } : null,
        });
        return waiting;
    } catch (err) {
        console.error('[shop-waitlist] back-in-stock question failed', { orgId: o.orgId, productId: o.productId, message: err instanceof Error ? err.message : String(err) });
        return 0;
    }
}

/** The email. Fixed words, never a price. Pure. */
export function backInStockEmail(o: { business: string; product: string; productUrl: string | null }): { subject: string; html: string; text: string } {
    const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const business = String(o.business || 'our shop').trim() || 'our shop';
    const subject = `${o.product} is back in stock — ${business}`.slice(0, 150);
    const html = `<p>Hello,</p>
<p>You asked ${esc(business)} to tell you when <strong>${esc(o.product)}</strong> was back in stock. It is now${o.productUrl ? '' : ' — visit our website to buy it'}.</p>
${o.productUrl ? `<p><a href="${esc(o.productUrl)}">See ${esc(o.product)}</a></p>` : ''}
<p style="font-size:12px;color:#666">This is the only email you'll get about it: you're no longer on the waiting list. You're getting it because you asked on our website.</p>`;
    const text = [
        'Hello,', '',
        `You asked ${business} to tell you when ${o.product} was back in stock. It is now${o.productUrl ? '' : ' — visit our website to buy it'}.`,
        ...(o.productUrl ? ['', `See it: ${o.productUrl}`] : []), '',
        'This is the only email you\'ll get about it: you\'re no longer on the waiting list. You\'re getting it because you asked on our website.',
    ].join('\n');
    return { subject, html, text };
}

export type SendResult = { ok: true; sent: number; skipped: number; failed: number; left: number } | { ok: false; error: string };

/**
 * Email the people waiting for a product (the owner's click). Never more than SEND_BATCH; each row is claimed before
 * its send and released if the send fails. Refused addresses are marked skipped and never emailed.
 */
export async function sendBackInStock(db: Db, o: { orgId: number; productId: number; deps?: { resolveRoute?: typeof resolveSendRoute; deliver?: typeof deliverStep } }): Promise<SendResult> {
    const product = await productBuyable(db, o.orgId, o.productId);
    if (!product) return { ok: false, error: 'That product isn\'t in your Business Information any more, so nobody was emailed.' };
    if (!product.buyable) return { ok: false, error: `${product.name} is still sold out, so nobody was emailed. Add stock first.` };
    const waiting = (await waitingCounts(db, o.orgId))[o.productId] ?? 0;
    if (!waiting) return { ok: true, sent: 0, skipped: 0, failed: 0, left: 0 };
    const [org] = asRows<{ name: string }>(await db.execute(sql`SELECT name FROM organisations WHERE id = ${o.orgId}`));
    const business = org?.name || 'Our shop';
    const routed = await (o.deps?.resolveRoute ?? resolveSendRoute)(db, o.orgId, { recipientCount: Math.min(waiting, SEND_BATCH), senderName: business });
    if ('error' in routed) return { ok: false, error: `Nobody was emailed: ${routed.error}` };

    // Claim this click's batch (oldest first) — a second click or tab can't take the same rows.
    const claimed = asRows<{ id: number; email: string; slug: string | null }>(await db.execute(sql`
        UPDATE shop_waitlist w SET notified_at = now()
         WHERE w.id IN (SELECT id FROM shop_waitlist WHERE organisation_id = ${o.orgId} AND product_id = ${o.productId} AND notified_at IS NULL
                         ORDER BY id LIMIT ${SEND_BATCH} FOR UPDATE SKIP LOCKED)
     RETURNING w.id, w.email, (SELECT slug FROM sites s WHERE s.id = w.site_id) AS slug`));
    const verdicts = await checkAudienceConsentBulk(db, o.orgId, claimed.map((c) => c.email), { consentGivenHere: true });
    let sent = 0, skipped = 0, failed = 0;
    for (const c of claimed) {
        const email = normaliseEmail(c.email);
        const v = verdicts.get(email);
        if (!v?.sendable) {
            await db.execute(sql`UPDATE shop_waitlist SET skip_reason = ${v?.reason ?? 'consent_check_failed'} WHERE id = ${c.id}`);
            skipped++;
            continue;
        }
        const productUrl = c.slug ? `${siteOrigin(c.slug)}${productPagePath({ id: o.productId, name: product.name })}` : null;
        const msg = backInStockEmail({ business, product: product.name, productUrl });
        try {
            await (o.deps?.deliver ?? deliverStep)(db, routed.route, o.orgId, { to: email, subject: msg.subject, html: msg.html, text: msg.text, listUnsubscribe: null });
            sent++;
        } catch (err) {
            console.error('[shop-waitlist] send failed (left waiting)', { id: c.id, message: err instanceof Error ? err.message : String(err) });
            await db.execute(sql`UPDATE shop_waitlist SET notified_at = NULL WHERE id = ${c.id}`).catch(() => {});
            failed++;
        }
    }
    const left = (await waitingCounts(db, o.orgId))[o.productId] ?? 0;
    return { ok: true, sent, skipped, failed, left };
}

/** What happened, in the owner's words. Pure. */
export function sendResultWords(name: string, r: SendResult): string {
    if (!r.ok) return r.error;
    if (!r.sent && !r.skipped && !r.failed) return `Nobody is waiting for ${name} now.`;
    const parts = [`Emailed ${r.sent} ${r.sent === 1 ? 'person' : 'people'} that ${name} is back.`];
    if (r.skipped) parts.push(`${r.skipped} skipped: they unsubscribed from your emails or can't be emailed.`);
    if (r.failed) parts.push(`${r.failed} couldn't be sent just now and ${r.failed === 1 ? 'is' : 'are'} still waiting.`);
    if (r.left) parts.push(`${r.left} still waiting: press "Email them" on the Shop tab's Stock card to send the next ${Math.min(r.left, SEND_BATCH)}.`);
    return parts.join(' ');
}

/** The daily sweep: emailed rows after 90 days, waiting rows after a year. Never throws. */
export async function sweepWaitlist(db: Db): Promise<number> {
    try {
        const rows = asRows<{ id: number }>(await db.execute(sql`
            DELETE FROM shop_waitlist WHERE (notified_at IS NOT NULL AND notified_at < now() - interval '90 days')
               OR (notified_at IS NULL AND created_at < now() - interval '365 days') RETURNING id`));
        return rows.length;
    } catch (err) {
        if (!isMissingWaitlist(err)) console.error('[shop-waitlist] sweep failed', err instanceof Error ? err.message : err);
        return 0;
    }
}
