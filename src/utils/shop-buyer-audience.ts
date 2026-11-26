// src/utils/shop-buyer-audience.ts — buyers who say yes join the Audience (online shop Phase 2, slice 4a; feature
// request #35, docs/online-shop-review-plan.md §12, owner Q2 2026-11-26). tests/shop-buyer-audience.test.ts.
//
// The basket page carries an UNTICKED box, "Send me news and offers from <business> by email". Ticked, it rides to
// Stripe as the Checkout Session's metadata (bms_news = '1'), and when the order is PAID (recordPaidCheckout) the
// buyer joins the Audience: basis single_opt_in (their own act), tag "Shop buyer", the consent written down.
// Unticked → never added: buying is not permission to send marketing (PECR). Single-product Buy buttons (a
// Website-only business) carry no box, so nobody is added from them.
//
// Refusals win, as everywhere in the Audience: upsertContact never lifts an unsubscribe, bounce or complaint, so a
// buyer who once said stop is not re-subscribed by ticking again on a later order.

import { and, eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { audienceContacts } from '../../db/schema';
import { applyTagsByName, recordConsentEvent, upsertContact } from './audience-store';
import { looksLikeEmail, normaliseEmail } from './audience-contacts';
import { splitName } from './enquiry-audience';

type Db = ReturnType<typeof getDb>;

/** The tag every shop buyer who asked for news carries in the Audience. */
export const SHOP_BUYER_TAG = 'Shop buyer';
/** The Checkout Session metadata key for the ticked box. */
export const NEWS_METADATA_KEY = 'bms_news';
/** The exact words of the box the buyer saw, carried to the paid order as consent evidence (review #901). */
export const NEWS_WORDS_METADATA_KEY = 'bms_news_words';

/** The box's words on the basket page. Pure. */
export function newsBoxLabel(businessName: string): string {
    return `Send me news and offers from ${String(businessName || 'this business').trim() || 'this business'} by email. You can unsubscribe at any time.`;
}

/** Did the buyer tick the box? Only the exact value counts. Pure. */
export function newsTicked(metadata: Record<string, string> | null | undefined): boolean {
    return metadata?.[NEWS_METADATA_KEY] === '1';
}

export type BuyerAudienceResult =
    | { result: 'added'; contactId: number }
    | { result: 'already'; contactId: number; status: string }
    | { result: 'no_email' };

/**
 * Add a buyer who ticked the box. One transaction: the contact, its consent record, then the tag — so they are
 * never subscribed without the evidence (review #901). The consent record is written whenever they END UP
 * subscribed, new or not: a pending (unconfirmed double-opt-in) contact whom this tick subscribes gets its basis
 * set to single_opt_in, and an already-subscribed one (e.g. soft opt-in) keeps the record of this explicit opt-in.
 * A refused contact (unsubscribed, bounced, complained, suppressed) stays as it is and gets no record.
 */
export async function addShopBuyerToAudience(db: Db, input: {
    organisationId: number; email: string | null; name: string | null; orderId: number;
    /** The box's words as shown on the basket page (Checkout metadata); a generic label if missing. */
    words?: string | null; sourceUrl?: string | null;
}): Promise<BuyerAudienceResult> {
    const email = normaliseEmail(input.email || '');
    if (!looksLikeEmail(email)) return { result: 'no_email' };
    return db.transaction(async (tx) => {
        const t = tx as unknown as Db;
        const [before] = await t.select({ status: audienceContacts.status }).from(audienceContacts)
            .where(and(eq(audienceContacts.organisationId, input.organisationId), eq(audienceContacts.email, email))).limit(1);
        const contact = await upsertContact(t, {
            organisationId: input.organisationId,
            email,
            ...splitName(input.name || ''),
            status: 'subscribed',
            source: 'web_form',
            sourceDetail: { siteOrderId: input.orderId },
            consentBasis: 'single_opt_in',
            confirmedAt: new Date(),
        });
        if (contact.status !== 'subscribed') return { result: 'already' as const, contactId: contact.id, status: contact.status };
        const newlySubscribed = !before || before.status !== 'subscribed';
        // upsertContact keeps an existing basis (COALESCE); a contact THIS tick subscribed is single opt-in.
        if (before && newlySubscribed) {
            await t.update(audienceContacts).set({ consentBasis: 'single_opt_in' })
                .where(and(eq(audienceContacts.id, contact.id), eq(audienceContacts.organisationId, input.organisationId)));
        }
        // The lawful basis, written down — with the exact words they ticked. Throws by design: the whole add rolls back.
        await recordConsentEvent(t, {
            organisationId: input.organisationId,
            contactId: contact.id,
            email,
            event: 'confirmed',
            channel: 'site',
            sourceUrl: input.sourceUrl ?? null,
            ipHash: null,
            userAgent: null,
            evidence: `Ticked "${String(input.words || newsBoxLabel('')).slice(0, 450)}" (unticked by default) on the website basket page before paying for order ${input.orderId}. Basis: single opt-in. Every email carries an unsubscribe link.`,
        });
        await applyTagsByName(t, input.organisationId, contact.id, [SHOP_BUYER_TAG]);
        return newlySubscribed ? { result: 'added' as const, contactId: contact.id } : { result: 'already' as const, contactId: contact.id, status: 'subscribed' };
    });
}

/** The line for the owner's "New order" email. Pure. */
export function buyerAudienceLine(r: BuyerAudienceResult | null): string | null {
    if (!r) return null;
    if (r.result === 'added') return 'They ticked "Send me news": they have joined your Audience (tag "Shop buyer").';
    if (r.result === 'already') return r.status === 'subscribed'
        ? 'They ticked "Send me news": they were already in your Audience (tagged "Shop buyer").'
        : r.status === 'unsubscribed'
            ? 'They ticked "Send me news", but they unsubscribed from your emails before, so they were not added back.'
            : 'They ticked "Send me news", but their address can\'t be emailed (it bounced or was reported before), so they were not added.';
    return null;
}
