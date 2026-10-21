// src/utils/offer-profile.ts
// "What does your business offer?" — which kinds of field Business Information shows.
//
// Every workspace used to see every field: a SaaS company adding a plan was asked for allergens and
// a booking deposit (owner, 2026-10-20). The fields belong to two kinds of business, so the owner
// says which they are, once, and the product form and the Hours tab follow:
//
//   bookings — people book time with them (appointments, classes, tables): a service's length and
//              deposit, and the booking rules / resources / calendar on the Hours tab
//   menu     — they serve food or drink: dietary markers and allergens
//
// The keys match the website's own "What your website does" (site-definition.ts SITE_FEATURES), so
// one word means one thing everywhere.
//
// Until they answer, it is GUESSED (inferOffers) — from the website's feature choice, then the
// business's own data, then its industry — and the tab says it was guessed. Hiding never loses
// anything: a product that already has an allergen or a deposit keeps showing that field
// (assets.html), so nothing typed in disappears.
//
// One server path: org-products.ts (GET returns it, PATCH { offer } saves it) — the tab's tick boxes
// and the Website Assistant's offer_profile card both go through it.

import { and, eq, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { bookings, organisations, orgOfferProfile, orgProducts, sites } from '../../db/schema';

type Db = ReturnType<typeof getDb>;

export const OFFER_KINDS = ['bookings', 'menu'] as const;
export type OfferKind = typeof OFFER_KINDS[number];

export const OFFER_LABELS: Record<OfferKind, string> = {
    bookings: 'People book time with us (appointments, classes or tables)',
    menu: 'We serve food or drink',
};

export interface OfferProfile {
    offers: OfferKind[];
    /** True once the owner has answered; false = guessed by inferOffers. */
    answered: boolean;
}

export function cleanOffers(v: unknown): OfferKind[] | null {
    if (!Array.isArray(v)) return null;
    return OFFER_KINDS.filter((k) => v.includes(k));
}

// Industry words that mean the kind of business, matched against the free-text industry field
// (whose suggestions are assets.html's datalist). A guess only — the owner's answer always wins.
const MENU_WORDS = /\b(food|beverage|drink|hospitality|restaurant|caf[eé]|coffee|bakery|bar|pub|catering|takeaway|deli|brewery|winery)\b/i;
const BOOKING_WORDS = /\b(beauty|wellness|salon|barber|spa|fitness|sport|gym|yoga|pilates|clinic|healthcare|therap|physio|dental|massage|tutor|coach|restaurant|hospitality|events?)\b/i;

/**
 * The guess, from what the business has already told us. Pure, for tests. Every signal is something
 * THEY did — a website feature they chose, data they entered, bookings customers made — except the
 * industry, which only ever adds a kind.
 */
export function inferOffers(signals: {
    siteFeatures?: readonly string[] | null;
    industry?: string | null;
    hasDietary?: boolean;
    hasBookingData?: boolean;
}): OfferKind[] {
    const out = new Set<OfferKind>();
    if (Array.isArray(signals.siteFeatures)) {
        if (signals.siteFeatures.includes('bookings')) out.add('bookings');
        if (signals.siteFeatures.includes('menu')) out.add('menu');
    }
    if (signals.hasDietary) out.add('menu');
    if (signals.hasBookingData) out.add('bookings');
    const ind = (signals.industry || '').trim();
    if (ind && MENU_WORDS.test(ind)) out.add('menu');
    if (ind && BOOKING_WORDS.test(ind)) out.add('bookings');
    return OFFER_KINDS.filter((k) => out.has(k));
}

/** The owner's answer only — null when they haven't given one (or the table isn't there yet). */
export async function loadAnsweredOffer(db: Db, organisationId: number): Promise<OfferProfile | null> {
    try {
        const [row] = await db.select({ offers: orgOfferProfile.offers }).from(orgOfferProfile)
            .where(eq(orgOfferProfile.organisationId, organisationId)).limit(1);
        return row ? { offers: cleanOffers(row.offers) ?? [], answered: true } : null;
    } catch {
        return null;
    }
}

/** The answer if there is one, else the guess. Never throws — a failed read is a guess from nothing. */
export async function loadOfferProfile(db: Db, organisationId: number): Promise<OfferProfile> {
    // No answer (or the table isn't applied yet — db/z-org-offer-profile.sql): guess.
    const answered = await loadAnsweredOffer(db, organisationId);
    if (answered) return answered;

    const safe = async <T>(p: Promise<T>, fallback: T): Promise<T> => { try { return await p; } catch { return fallback; } };
    const [org] = await safe(db.select({ industry: organisations.industry }).from(organisations).where(eq(organisations.id, organisationId)).limit(1), []);
    const siteRows = await safe(db.select({ draft: sites.draft }).from(sites).where(eq(sites.organisationId, organisationId)).limit(1), []);
    const [stats] = await safe(db.select({
        dietary: sql<number>`count(*) filter (where (${orgProducts.dietary} is not null and ${orgProducts.dietary}::text not in ('null', '[]')) or coalesce(${orgProducts.allergens}, '') <> '')::int`,
        booking: sql<number>`count(*) filter (where ${orgProducts.durationMinutes} is not null or ${orgProducts.depositType} is not null)::int`,
    }).from(orgProducts).where(and(eq(orgProducts.organisationId, organisationId), eq(orgProducts.status, 'active'))), []);
    const [booked] = await safe(db.select({ id: bookings.id }).from(bookings).where(eq(bookings.organisationId, organisationId)).limit(1), []);

    const features = (siteRows[0]?.draft as { settings?: { features?: unknown } } | undefined)?.settings?.features;
    return {
        offers: inferOffers({
            siteFeatures: Array.isArray(features) ? features as string[] : null,
            industry: org?.industry ?? null,
            hasDietary: Number(stats?.dietary) > 0,
            hasBookingData: Number(stats?.booking) > 0 || Boolean(booked),
        }),
        answered: false,
    };
}

/** Save the owner's answer. Throws when the table is missing, so the caller can say so. */
export async function saveOfferProfile(db: Db, organisationId: number, offers: OfferKind[], userId: number | null): Promise<OfferProfile> {
    await db.insert(orgOfferProfile)
        .values({ organisationId, offers, updatedBy: userId, updatedAt: new Date() })
        .onConflictDoUpdate({ target: orgOfferProfile.organisationId, set: { offers, updatedBy: userId, updatedAt: new Date() } });
    return { offers, answered: true };
}

/** One line for an assistant's prompt — what this business does and does not offer. */
export function describeOfferProfile(p: OfferProfile): string {
    const on = p.offers.map((k) => OFFER_LABELS[k].toLowerCase());
    const off = OFFER_KINDS.filter((k) => !p.offers.includes(k)).map((k) => OFFER_LABELS[k].toLowerCase());
    return `What the business offers (${p.answered ? 'their answer' : 'a guess — not confirmed by them'}, Business Information ▸ Products & Services): ${on.length ? on.join('; ') : 'neither bookings nor food and drink'}.${off.length ? ` Not offered: ${off.join('; ')} — ${p.answered ? "don't ask about or suggest those" : "don't assume them; if they come up, check with the user"}.` : ''}`;
}
