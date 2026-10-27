// src/utils/offer-profile.ts
// "What does your business offer?" — which fields Business Information shows, and what every
// assistant assumes about the business.
//
// Every workspace used to see every field: a SaaS company adding a plan was asked for allergens and
// a booking deposit (owner, 2026-10-20). Then the question itself was too narrow — two boxes, both
// for a café or a salon (owner, 2026-10-21). Six ticks now, any mix, and EACH ONE CHANGES SOMETHING
// REAL — a tick that changes nothing is a survey question:
//
//   products       — physical or digital goods: new items default to "Product"; "bought online" note
//   services       — consulting, trades, coaching, agencies: new items default to "Service" when
//                    they sell no products
//   subscriptions  — software or memberships: a new item's price defaults to "a month"
//   bookings       — appointments, classes, tables, events: a service's length and deposit, and the
//                    Bookings tab (rules, who can be booked, calendar)
//   visits         — customers come to them: the Hours & Location tab (bookings needs hours too)
//   menu           — food or drink: dietary markers and allergens
//
// The keys match the website's own feature words where they overlap (site-definition.ts
// SITE_FEATURES: shop ↔ products, hours ↔ visits, bookings, menu).
//
// Until they answer, it is GUESSED (inferOffers) — from the website's feature choice, the business's
// own data, then its industry — and the tab says so. Hiding never loses anything: a product holding a
// value keeps showing that field (assets.html), and a hidden tab keeps what is saved on it.
//
// One server path: org-products.ts (GET returns it, PATCH { offer } saves it) — the tab's tick boxes
// and the Website Assistant's offer_profile card both go through it.

import { and, eq, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { bookingSettings, bookings, organisations, orgOfferProfile, orgProducts, sites } from '../../db/schema';

type Db = ReturnType<typeof getDb>;

export const OFFER_KINDS = ['products', 'services', 'subscriptions', 'bookings', 'visits', 'menu'] as const;
export type OfferKind = typeof OFFER_KINDS[number];

export const OFFER_LABELS: Record<OfferKind, string> = {
    products: 'We sell products (physical or digital)',
    services: 'We provide services (consulting, trades, coaching, agencies)',
    subscriptions: 'We sell software or subscriptions',
    bookings: 'People book time with us (appointments, classes, tables or events)',
    visits: 'Customers visit us (a shop, venue or studio)',
    menu: 'We serve food or drink',
};

/**
 * Stored beside the ticks on every answer to the six-option question. An answer WITHOUT it was given
 * to the old two-box question (bookings / food, 2026-10-20) — it says nothing about the other four,
 * so those are guessed and the owner is asked again, rather than every assistant being told firmly
 * that the business sells nothing. Stripped on read (cleanOffers keeps known kinds only).
 */
const ASKED_ALL = 'asked:6';

export interface OfferProfile {
    offers: OfferKind[];
    /** True once the owner has answered the six-option question; false = (partly) guessed. */
    answered: boolean;
}

export function cleanOffers(v: unknown): OfferKind[] | null {
    if (!Array.isArray(v)) return null;
    return OFFER_KINDS.filter((k) => v.includes(k));
}

// Industry words, matched against the free-text industry field (its suggestions are assets.html's
// datalist). A guess only — the owner's answer always wins.
const INDUSTRY_WORDS: Record<OfferKind, RegExp> = {
    products: /\b(retail|e-?commerce|fashion|apparel|manufactur\w*|shop|store|bakery|brewery|winery|agricultur\w*|crafts?)\b/i,
    services: /\b(consult\w*|agency|agencies|marketing|advertising|legal|law|accounting|accountan\w*|financ\w*|architecture|design|construction|trades?|recruit\w*|hr|coach\w*|creative|media|education|training|healthcare|health|wellbeing|beauty|wellness|insurance|property|real estate|logistics|transport|automotive|events|photograph\w*|cleaning|it services)\b/i,
    subscriptions: /\b(saas|software|subscriptions?|memberships?|telecom\w*|apps?)\b/i,
    bookings: /\b(beauty|wellness|wellbeing|salon|barber|spa|fitness|sport|gym|yoga|pilates|clinic|healthcare|therap\w*|physio|dental|massage|tutor\w*|coach\w*|restaurant|hospitality|events?|travel|tourism)\b/i,
    visits: /\b(retail|shop|store|hospitality|restaurant|caf[eé]|coffee|bar|pub|salon|barber|spa|gym|fitness|clinic|dental|venue|hotel|bakery|deli|garden centre|showroom)\b/i,
    menu: /\b(food|beverage|drink|hospitality|restaurant|caf[eé]|coffee|bakery|bar|pub|catering|takeaway|deli|brewery|winery)\b/i,
};

/**
 * The guess, from what the business has already told us. Pure, for tests. Every signal is something
 * THEY did — a website feature they chose, data they entered, bookings customers made — except the
 * industry, which only ever adds a kind.
 */
export function inferOffers(signals: {
    siteFeatures?: readonly string[] | null;
    industry?: string | null;
    hasProducts?: boolean;
    hasServices?: boolean;
    hasRecurringPrice?: boolean;
    hasDietary?: boolean;
    hasBookingData?: boolean;
    hasVisitAddress?: boolean;
}): OfferKind[] {
    const out = new Set<OfferKind>();
    const f = Array.isArray(signals.siteFeatures) ? signals.siteFeatures : [];
    if (f.includes('shop')) out.add('products');
    if (f.includes('bookings')) out.add('bookings');
    if (f.includes('menu')) out.add('menu');
    if (f.includes('hours')) out.add('visits');
    if (signals.hasProducts) out.add('products');
    if (signals.hasServices) out.add('services');
    if (signals.hasRecurringPrice) out.add('subscriptions');
    if (signals.hasDietary) out.add('menu');
    if (signals.hasBookingData) out.add('bookings');
    if (signals.hasVisitAddress) out.add('visits');
    const ind = (signals.industry || '').trim();
    if (ind) for (const k of OFFER_KINDS) if (INDUSTRY_WORDS[k].test(ind)) out.add(k);
    return OFFER_KINDS.filter((k) => out.has(k));
}

/** The stored row, read as an answer: complete (six-option), legacy (two-box), or none. */
function readRow(offers: unknown): { offers: OfferKind[]; complete: boolean } {
    return { offers: cleanOffers(offers) ?? [], complete: Array.isArray(offers) && offers.includes(ASKED_ALL) };
}

/**
 * The owner's COMPLETE answer only — null when they haven't answered the six-option question (or
 * the table isn't there yet). This is what every assistant is told, so a guess never steers them.
 */
export async function loadAnsweredOffer(db: Db, organisationId: number): Promise<OfferProfile | null> {
    try {
        const [row] = await db.select({ offers: orgOfferProfile.offers }).from(orgOfferProfile)
            .where(eq(orgOfferProfile.organisationId, organisationId)).limit(1);
        if (!row) return null;
        const r = readRow(row.offers);
        return r.complete ? { offers: r.offers, answered: true } : null;
    } catch {
        return null;
    }
}

/** The answer if there is one, else the guess. Never throws — a failed read is a guess from nothing. */
export async function loadOfferProfile(db: Db, organisationId: number): Promise<OfferProfile> {
    const safe = async <T>(p: Promise<T>, fallback: T): Promise<T> => { try { return await p; } catch { return fallback; } };
    // No row, or the table isn't applied yet (db/z-org-offer-profile.sql): guess.
    const [row] = await safe(db.select({ offers: orgOfferProfile.offers }).from(orgOfferProfile)
        .where(eq(orgOfferProfile.organisationId, organisationId)).limit(1), []);
    const stored = row ? readRow(row.offers) : null;
    if (stored?.complete) return { offers: stored.offers, answered: true };

    const [org] = await safe(db.select({ industry: organisations.industry }).from(organisations).where(eq(organisations.id, organisationId)).limit(1), []);
    const siteRows = await safe(db.select({ draft: sites.draft }).from(sites).where(eq(sites.organisationId, organisationId)).limit(1), []);
    const [stats] = await safe(db.select({
        products: sql<number>`count(*) filter (where ${orgProducts.kind} = 'product')::int`,
        services: sql<number>`count(*) filter (where ${orgProducts.kind} = 'service')::int`,
        recurring: sql<number>`count(*) filter (where coalesce(${orgProducts.priceUnit}, '') ~* '(month|mo\\M|year|annum|week)' or coalesce(${orgProducts.price}, '') ~* '(/ ?mo|a month|per month|monthly|a year|per year|annual)')::int`,
        dietary: sql<number>`count(*) filter (where (${orgProducts.dietary} is not null and ${orgProducts.dietary}::text not in ('null', '[]')) or coalesce(${orgProducts.allergens}, '') <> '')::int`,
        booking: sql<number>`count(*) filter (where ${orgProducts.durationMinutes} is not null or ${orgProducts.depositType} is not null)::int`,
    }).from(orgProducts).where(and(eq(orgProducts.organisationId, organisationId), eq(orgProducts.status, 'active'))), []);
    const [booked] = await safe(db.select({ id: bookings.id }).from(bookings).where(eq(bookings.organisationId, organisationId)).limit(1), []);
    const [bs] = await safe(db.select({ visitAddress: bookingSettings.visitAddress }).from(bookingSettings).where(eq(bookingSettings.organisationId, organisationId)).limit(1), []);

    const features = (siteRows[0]?.draft as { settings?: { features?: unknown } } | undefined)?.settings?.features;
    const guess = inferOffers({
        siteFeatures: Array.isArray(features) ? features as string[] : null,
        industry: org?.industry ?? null,
        hasProducts: Number(stats?.products) > 0,
        hasServices: Number(stats?.services) > 0,
        hasRecurringPrice: Number(stats?.recurring) > 0,
        hasDietary: Number(stats?.dietary) > 0,
        hasBookingData: Number(stats?.booking) > 0 || Boolean(booked),
        hasVisitAddress: Boolean(bs?.visitAddress && bs.visitAddress.trim()),
    });
    if (!stored) return { offers: guess, answered: false };
    // An answer to the old two-box question: keep what it said about bookings and food, guess the rest.
    const legacy = new Set<OfferKind>(stored.offers);
    for (const k of guess) if (k !== 'bookings' && k !== 'menu') legacy.add(k);
    return { offers: OFFER_KINDS.filter((k) => legacy.has(k)), answered: false };
}

/** Save the owner's answer. Throws when the table is missing, so the caller can say so. */
export async function saveOfferProfile(db: Db, organisationId: number, offers: OfferKind[], userId: number | null): Promise<OfferProfile> {
    const stored = [...offers, ASKED_ALL];
    await db.insert(orgOfferProfile)
        .values({ organisationId, offers: stored, updatedBy: userId, updatedAt: new Date() })
        .onConflictDoUpdate({ target: orgOfferProfile.organisationId, set: { offers: stored, updatedBy: userId, updatedAt: new Date() } });
    return { offers, answered: true };
}

/** One line for an assistant's prompt — what this business does and does not offer. */
export function describeOfferProfile(p: OfferProfile): string {
    const on = p.offers.map((k) => OFFER_LABELS[k].replace(/^We |^People |^Customers /, (m) => m.toLowerCase()));
    const off = OFFER_KINDS.filter((k) => !p.offers.includes(k)).map((k) => OFFER_LABELS[k].replace(/^We |^People |^Customers /, (m) => m.toLowerCase()));
    return `What the business offers (${p.answered ? 'their answer' : 'a guess — not confirmed by them'}, Business Information ▸ Products & Services): ${on.length ? on.join('; ') : 'none of the usual kinds ticked'}.${off.length ? ` Not ticked: ${off.join('; ')} — ${p.answered ? "don't assume or suggest those" : "don't assume them; if they come up, check with the user"}.` : ''}`;
}
