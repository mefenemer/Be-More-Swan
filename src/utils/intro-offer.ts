// src/utils/intro-offer.ts
// "Do you offer a free trial or an introductory offer?" — Business Information ▸ Products & Services.
//
// Owner, 2026-10-24: whether the business offers a free trial (and on what terms — how many days,
// card up front or not) should be asked, and every assistant should know the answer. Before this a
// model could only guess: an outreach email or a post could promise "a free month" the business
// never offered, and the quality reviewer could only point the owner at one assistant's Incentive
// box. Now it is ONE workspace answer, read by every drafting seam through org-products.ts:
//
//   loadProductsBlock   → chat (every role), social autopilot, blogs, emails, outreach, sites
//   loadOfferingsText   → the short-form seams (auto-responder, conversion posts, goals, bio)
//   introOfferFact      → the quality reviewer's declared facts (post-quality-review.ts)
//
// Three states, and each tells the assistants something different:
//   null           — not answered: never promise an offer
//   { has: false } — their answer is NO: never offer or hint at one
//   { has: true }  — their answer: use it, exactly as written
// An assistant's own brief (Creative Brief ▸ Standard offer / incentive) still counts — that is
// the owner's word too, for one assistant.
//
// One server path: org-products.ts (GET returns it, PATCH { introOffer } saves it) — the tab's form
// and the intro_offer chat card both go through it. Its own table (db/z-org-intro-offer.sql), so
// saving an offer can never write a half-answer into org_offer_profile.

import { eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { orgIntroOffer } from '../../db/schema';
import type { OfferKind } from './offer-profile';

type Db = ReturnType<typeof getDb>;

export const INTRO_OFFER_KINDS = [
    'free_trial', 'freemium', 'free_consultation', 'first_visit', 'intro_discount', 'free_sample', 'money_back', 'other',
] as const;
export type IntroOfferKind = typeof INTRO_OFFER_KINDS[number];

export const INTRO_OFFER_LABELS: Record<IntroOfferKind, string> = {
    free_trial: 'A free trial',
    freemium: 'A free plan',
    free_consultation: 'A free consultation or discovery call',
    first_visit: 'A first-visit or first-booking offer',
    intro_discount: 'An introductory discount',
    free_sample: 'A free sample or taster',
    money_back: 'A money-back guarantee',
    other: 'Something else',
};

/** Kinds that need a number of days; kinds that need the deal spelt out. */
const NEEDS_DAYS: readonly IntroOfferKind[] = ['free_trial', 'money_back'];
const NEEDS_TERMS: readonly IntroOfferKind[] = ['freemium', 'first_visit', 'intro_discount', 'other'];

export const INTRO_OFFER_LIMITS = { terms: 300, whoFor: 200, appliesTo: 200, url: 500, maxDays: 365 } as const;

export type IntroOffer =
    | { has: false }
    | {
        has: true;
        kind: IntroOfferKind;
        /** free_trial / money_back only. */
        days: number | null;
        /** free_trial only: true = card taken at sign-up, false = no card, null = not said. */
        cardUpFront: boolean | null;
        /** free_trial only: what happens when it ends. */
        afterwards: 'auto_charge' | 'stops' | null;
        terms: string | null;
        whoFor: string | null;
        appliesTo: string | null;
        url: string | null;
    };

const text = (v: unknown, max: number): string | null => {
    const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
    return s ? s.slice(0, max) : null;
};

/**
 * The one gate — tab, chat card and stored row all pass it. Pure. Returns the clean offer, or an
 * error in words the owner can act on. Fields that don't apply to the kind are dropped, not kept.
 */
export function cleanIntroOffer(v: unknown): { offer: IntroOffer } | { error: string } {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: 'Say whether you offer a free trial or introductory offer.' };
    const o = v as Record<string, unknown>;
    if (o.has === false) return { offer: { has: false } };
    if (o.has !== true) return { error: 'Say whether you offer a free trial or introductory offer.' };
    const kind = INTRO_OFFER_KINDS.find((k) => k === o.kind);
    if (!kind) return { error: 'Choose what kind of offer it is.' };

    let days: number | null = null;
    if (NEEDS_DAYS.includes(kind)) {
        const n = Number(o.days);
        if (!Number.isInteger(n) || n < 1 || n > INTRO_OFFER_LIMITS.maxDays) {
            return { error: `Say how many days it lasts (1–${INTRO_OFFER_LIMITS.maxDays}).` };
        }
        days = n;
    }
    const isTrial = kind === 'free_trial';
    const cardUpFront = isTrial && typeof o.cardUpFront === 'boolean' ? o.cardUpFront : null;
    const afterwards = isTrial && (o.afterwards === 'auto_charge' || o.afterwards === 'stops') ? o.afterwards : null;
    const terms = text(o.terms, INTRO_OFFER_LIMITS.terms);
    if (NEEDS_TERMS.includes(kind) && !terms) return { error: 'Describe the offer in a few words — for example "20% off your first visit".' };

    let url = text(o.url, INTRO_OFFER_LIMITS.url);
    if (url) {
        if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
        try { url = new URL(url).toString(); } catch { return { error: 'That link doesn\'t look like a web address.' }; }
    }
    return {
        offer: {
            has: true, kind, days, cardUpFront, afterwards, terms,
            whoFor: text(o.whoFor, INTRO_OFFER_LIMITS.whoFor),
            appliesTo: text(o.appliesTo, INTRO_OFFER_LIMITS.appliesTo),
            url,
        },
    };
}

/**
 * The kinds that fit what the business offers (offer-profile.ts), most likely first — the form's
 * order and its default. Every kind stays available; this only orders them. Pure.
 */
export function suggestedIntroKinds(offers: readonly OfferKind[] | null | undefined): IntroOfferKind[] {
    const has = (k: OfferKind) => !!offers && offers.includes(k);
    const first: IntroOfferKind[] = [];
    if (has('subscriptions')) first.push('free_trial', 'freemium', 'money_back');
    if (has('services')) first.push('free_consultation', 'intro_discount');
    if (has('bookings') || has('visits')) first.push('first_visit', 'intro_discount');
    if (has('products') || has('menu')) first.push('free_sample', 'intro_discount', 'money_back');
    return [...new Set([...first, ...INTRO_OFFER_KINDS])];
}

/** The question, in the business's own terms. Pure; the tab mirrors it. */
export function introOfferQuestion(offers: readonly OfferKind[] | null | undefined): string {
    const has = (k: OfferKind) => !!offers && offers.includes(k);
    if (has('subscriptions')) return 'Do you offer a free trial?';
    if (has('services') || has('bookings')) return 'Do you offer a free consultation or an introductory offer?';
    return 'Do you offer new customers a free trial or an introductory offer?';
}

/** The offer in one plain sentence — "A free 14-day trial, no card needed up front; …". Pure. */
export function summariseIntroOffer(o: Extract<IntroOffer, { has: true }>): string {
    let head: string;
    if (o.kind === 'free_trial') {
        head = `A free ${o.days}-day trial`;
        if (o.cardUpFront === false) head += ', no card needed up front';
        if (o.cardUpFront === true) head += ', card details taken at sign-up';
        if (o.afterwards === 'auto_charge') head += '; when it ends the paid plan starts automatically unless they cancel';
        if (o.afterwards === 'stops') head += '; when it ends it simply stops — nothing is charged unless they choose a plan';
    } else if (o.kind === 'money_back') {
        head = `A ${o.days}-day money-back guarantee`;
    } else {
        head = INTRO_OFFER_LABELS[o.kind] === INTRO_OFFER_LABELS.other ? 'An introductory offer' : INTRO_OFFER_LABELS[o.kind];
    }
    const parts = [o.terms ? `${head}: ${o.terms.replace(/[.\s]+$/, '')}.` : `${head}.`];
    if (o.whoFor) parts.push(`Who can have it: ${o.whoFor.replace(/[.\s]+$/, '')}.`);
    if (o.appliesTo) parts.push(`Applies to: ${o.appliesTo.replace(/[.\s]+$/, '')}.`);
    if (o.url) parts.push(`Where to start: ${o.url}`);
    return parts.join(' ');
}

const WHERE = 'Business Information ▸ Products & Services ▸ Free trial or introductory offer';
const BRIEF_EXCEPTION = 'An offer written in this assistant\'s own brief (its standard offer or incentive), or one the user asks you for in this conversation, still counts.';

/** The block every assistant reads (via loadProductsBlock). Pure. */
export function describeIntroOffer(o: IntroOffer | null): string {
    if (!o) {
        return `INTRODUCTORY OFFER: not recorded yet (${WHERE}). Never promise a free trial, free consultation, first-visit offer, discount or guarantee — you don't know that one exists. ${BRIEF_EXCEPTION}`;
    }
    if (!o.has) {
        return `INTRODUCTORY OFFER (their answer, ${WHERE}): they do NOT offer a free trial or any introductory deal. Never offer, suggest or hint at one — no "free trial", "first month free", "free consultation", "no card needed" or discount code. ${BRIEF_EXCEPTION}`;
    }
    return `INTRODUCTORY OFFER (their answer, ${WHERE}): ${summariseIntroOffer(o)}
Use it as the call to action where it genuinely helps — an outreach email, a sign-up or pricing question, an email's closing ask, an occasional post — not in every piece. State it exactly as written: never change the length, the terms or who can have it, never add a deadline or scarcity ("only 5 places left") they did not give, and never offer any other trial, discount or deal. Link only to the "Where to start" address, if there is one.`;
}

/** The short form, for prompts that only name what is on offer (org-products.ts loadOfferingsText). Pure. */
export function introOfferShortLine(o: IntroOffer | null): string {
    if (!o) return '';
    if (!o.has) return 'No free trial or introductory offer.';
    return `Introductory offer: ${summariseIntroOffer(o)}`;
}

/** A declared fact for the quality reviewer (post-quality-review.ts). '' when not answered. Pure. */
export function introOfferFact(o: IntroOffer | null): string {
    if (!o) return '';
    if (!o.has) return 'Free trial / introductory offer: NONE — the business offers no free trial, free consultation, discount or introductory deal (unless a standard offer / incentive below names one).';
    return `Free trial / introductory offer (the business's own terms — any other offer, or different terms, is not declared): ${summariseIntroOffer(o)}`;
}

/** The stored answer, or null — not answered, or the table isn't applied yet. Never throws. */
export async function loadIntroOffer(db: Db, organisationId: number): Promise<IntroOffer | null> {
    try {
        const [row] = await db.select({ offer: orgIntroOffer.offer }).from(orgIntroOffer)
            .where(eq(orgIntroOffer.organisationId, organisationId)).limit(1);
        if (!row) return null;
        // Re-checked on read, so a row written by an older rule can't put a malformed offer in a prompt.
        const r = cleanIntroOffer(row.offer);
        return 'offer' in r ? r.offer : null;
    } catch {
        return null;
    }
}

/** Save the owner's answer. Throws when the table is missing, so the caller can say so. */
export async function saveIntroOffer(db: Db, organisationId: number, offer: IntroOffer, userId: number | null): Promise<IntroOffer> {
    await db.insert(orgIntroOffer)
        .values({ organisationId, offer, updatedBy: userId, updatedAt: new Date() })
        .onConflictDoUpdate({ target: orgIntroOffer.organisationId, set: { offer, updatedBy: userId, updatedAt: new Date() } });
    return offer;
}

// ── Chat: the intro_offer card (every assistant's chat; chat-orchestrator.ts) ────────────────────

export const INTRO_OFFER_CARD_TYPE = 'intro_offer';

/** What every structured chat route is told about the card. Pure. */
export function introOfferPromptBlock(): string {
    return `FREE TRIAL OR INTRODUCTORY OFFER — the workspace's ONE answer to "do you offer a free trial or introductory offer?", which every assistant uses (the INTRODUCTORY OFFER line above). When the user tells you what it is, that they don't have one, or that the line above is wrong, put this in "uiElement" (one per reply), using ONLY what they said — never your own guess, never a length or term they didn't give (ask instead):
{ "type": "intro_offer", "summary": "<one sentence>", "offer": { "has": false } }
{ "type": "intro_offer", "summary": "<one sentence>", "offer": { "has": true, "kind": "${INTRO_OFFER_KINDS.join('" | "')}", "days": <whole days — free_trial and money_back only, else null>, "cardUpFront": true | false | null, "afterwards": "auto_charge" | "stops" | null, "terms": "<the deal in their words, e.g. 20% off your first visit>" | null, "whoFor": "<e.g. new customers only>" | null, "appliesTo": "<which products or plans>" | null, "url": "<where to sign up, only a link they gave>" | null } }
"terms" is required for freemium, first_visit, intro_discount and other. You never save it yourself: the user confirms on the card, and only that click saves it — so never say it HAS been saved, say the card is there to confirm. They can also change it any time under ${WHERE}.`;
}

export interface IntroOfferCard { type: typeof INTRO_OFFER_CARD_TYPE; summary: string | null; offer: IntroOffer }

/**
 * The model's card, checked through the same gate as the tab. Null when it isn't an intro_offer
 * card; { error } when it is one the gate refuses (the reply then says so). Pure.
 */
export function introOfferCardFromUiElement(ui: unknown): IntroOfferCard | { error: string } | null {
    if (!ui || typeof ui !== 'object' || (ui as { type?: unknown }).type !== INTRO_OFFER_CARD_TYPE) return null;
    const r = cleanIntroOffer((ui as { offer?: unknown }).offer);
    if ('error' in r) return r;
    return { type: INTRO_OFFER_CARD_TYPE, summary: text((ui as { summary?: unknown }).summary, 300), offer: r.offer };
}
