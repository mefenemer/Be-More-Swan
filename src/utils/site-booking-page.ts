// src/utils/site-booking-page.ts — the booking link of its own: https://<slug>.bemoreswan.site/book
// (or the business's own domain + /book). docs/booking-calendly-gaps-plan.md A. tests/site-booking-page.test.ts.
//
// It works as soon as bookings are set up (opening hours, and something to book), whether or not the
// website is published:
//   - published site: /book goes to the site's own booking section for what was asked (so the
//     owner's choices — which services, a choice of staff — still hold), or to the booking link's
//     own section (site-booking.ts virtualSection) when the site has none or the service asked for
//     isn't in it;
//   - not published: the address shows only the booking pages, in the site's look, with nothing
//     else from the draft (bookingOnlyDefinition) — and its home page sends people to /book.
// Deep links: /book?svc=<product id>&res=<person id> skip straight past "what" and "who"; every
// choice is checked again by the booking steps, as always.
//
// Bookings need the Website Assistant (owner, 2026-11-08): the address is its site's.

import { and, desc, eq, isNotNull, isNull, ne } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, sites } from '../../db/schema';
import { normaliseSiteDefinition, type BookingSectionKind, type SiteDefinition } from './site-definition';
import { BOOKING_PAGE_PATH, esc } from './site-render';
import { loadBookingSetup, resourcesForKind, type BookingSetup } from './bookings';
import { bookableSessions, classServiceIds } from './class-sessions';
import { meetingLocationOf } from './booking-meeting';
import { bookLink, findBookingSection, page, virtualSectionId, type BookCtx, type BookPage } from './site-booking';
import { siteOrigin } from './site-hosting';
import { currentDomain } from './site-domains';

type Db = ReturnType<typeof getDb>;

const KIND_LABEL: Record<BookingSectionKind, string> = {
    appointment: 'Book an appointment', consultation: 'Book a consultation', table: 'Book a table', class: 'Book a class or event',
};

/** Appointments, worded as consultations when every service is a call (booking-meeting.ts). Pure. */
export function serviceKind(services: Array<{ meetingLocation?: string | null }>): 'appointment' | 'consultation' {
    return services.length && services.every((s) => meetingLocationOf(s.meetingLocation) !== 'in_person') ? 'consultation' : 'appointment';
}

/**
 * What the booking link can offer, from Business Information alone: services with a length (not
 * those run as classes), tables (once a table or seating area is set up), classes (an upcoming
 * date). Nothing at all without opening hours — except classes, which opening hours don't limit.
 */
export async function bookableKinds(db: Db, orgId: number, now: Date, setup?: BookingSetup): Promise<BookingSectionKind[]> {
    const st = setup ?? await loadBookingSetup(db, orgId);
    const hours = Object.keys(st.settings.weeklyHours).length > 0;
    const out: BookingSectionKind[] = [];
    if (hours) {
        const asClasses = await classServiceIds(db, orgId);
        const svc = st.services.filter((s) => !asClasses.has(s.id));
        if (svc.length) out.push(serviceKind(svc));
        if (resourcesForKind(st, 'table').length) out.push('table');
    }
    if ((await bookableSessions(db, orgId, now, [], 1)).length) out.push('class');
    return out;
}

/** The owner switched "Bookings" off in what this website does (site-definition.ts features): no booking link. Pure. */
export function bookingsSwitchedOff(def: Pick<SiteDefinition, 'settings'>): boolean {
    const f = def.settings.features;
    return Array.isArray(f) && !f.includes('bookings');
}

/**
 * Whether a site's address takes bookings although the site isn't published: a draft (never one
 * taken offline), its Website Assistant not archived, bookings not switched off, and something to book.
 */
export async function bookingOnlyAllowed(db: Db, site: { status: string; organisationId: number; aiAssistantId: number }, draft: SiteDefinition, now: Date): Promise<boolean> {
    if (site.status !== 'draft' || bookingsSwitchedOff(draft)) return false;
    const [a] = await db.select({ archivedAt: aiAssistants.archivedAt }).from(aiAssistants).where(eq(aiAssistants.id, site.aiAssistantId)).limit(1);
    if (!a || a.archivedAt) return false;
    return (await bookableKinds(db, site.organisationId, now)).length > 0;
}

/** The kinds a published site's own booking sections take, each with its first section's id. Pure. */
export function siteSectionsByKind(def: SiteDefinition | null): Map<BookingSectionKind, { id: string; heading: string | null; serviceIds: number[] }> {
    const out = new Map<BookingSectionKind, { id: string; heading: string | null; serviceIds: number[] }>();
    for (const p of def?.pages ?? []) for (const s of p.sections) {
        if (s.type === 'booking' && !out.has(s.props.kind)) out.set(s.props.kind, { id: s.id, heading: s.props.heading, serviceIds: s.props.serviceIds });
    }
    return out;
}

/**
 * A draft site seen only for its booking pages: its look, name and details, none of its pages (so
 * nothing unpublished shows and the menu is empty). Pure.
 */
export function bookingOnlyDefinition(draft: SiteDefinition): SiteDefinition {
    return { ...draft, nav: [], pages: [], structure: 'pages' };
}

/**
 * The booking-only definition for a draft site, or null when its address takes no bookings. Only
 * the draft's look, name and details are read — never its pages (site-serve serves no draft page).
 */
export async function bookingOnlySite(db: Db, site: { status: string; organisationId: number; aiAssistantId: number; draft: unknown }, now: Date): Promise<SiteDefinition | null> {
    if (site.status !== 'draft') return null;
    const draft = normaliseSiteDefinition(site.draft, { maxPages: 1000 }).definition;
    return (await bookingOnlyAllowed(db, site, draft, now)) ? bookingOnlyDefinition(draft) : null;
}

/** GET /book — straight to the right booking steps, or a choice when the business takes more than one kind. */
export async function bookingPage(b: BookCtx, q: URLSearchParams, published: boolean): Promise<BookPage> {
    if (bookingsSwitchedOff(b.def)) return page(b, 'Booking isn\'t open', '<h1>Booking isn\'t open right now</h1><p>Please get in touch with us to book.</p>', 404);
    const setup = await loadBookingSetup(b.db, b.site.organisationId);
    const kinds = await bookableKinds(b.db, b.site.organisationId, b.now, setup);
    const own: ReturnType<typeof siteSectionsByKind> = published ? siteSectionsByKind(b.def) : new Map();
    const svcRaw = Number(q.get('svc'));
    const resRaw = Number(q.get('res'));
    const svc = Number.isInteger(svcRaw) && svcRaw > 0 ? setup.services.find((x) => x.id === svcRaw) ?? null : null;
    const res = Number.isInteger(resRaw) && resRaw > 0 && setup.resources.some((r) => r.id === resRaw) ? resRaw : null;

    // A link for one service: the site's section that offers it, else the booking link's own.
    if (svc) {
        const asClasses = await classServiceIds(b.db, b.site.organisationId);
        if (!asClasses.has(svc.id) && Object.keys(setup.settings.weeklyHours).length) {
            const fit = [...own.entries()].find(([k, s]) => k !== 'table' && k !== 'class' && (!s.serviceIds.length || s.serviceIds.includes(svc.id)));
            const s = fit ? fit[1].id : virtualSectionId(kinds.find((k) => k === 'appointment' || k === 'consultation') ?? 'appointment');
            return { status: 303, location: bookLink({ s, svc: svc.id, party: 0, res: res ?? null, date: null, time: null }) };
        }
    }

    // The kinds on offer: the published site's own booking sections when it has any, else Business Information's.
    const choices: Array<{ kind: BookingSectionKind; id: string; label: string }> = own.size
        ? [...own.entries()].map(([kind, s]) => ({ kind, id: s.id, label: s.heading || KIND_LABEL[kind] }))
        : kinds.map((kind) => ({ kind, id: virtualSectionId(kind), label: KIND_LABEL[kind] }));
    const usable = choices.filter((c) => findBookingSection(b.def, c.id));
    if (!usable.length) {
        return page(b, 'Booking isn\'t open', '<h1>Booking isn\'t open right now</h1><p>Please get in touch with us to book.</p>');
    }
    if (usable.length === 1) {
        return { status: 303, location: bookLink({ s: usable[0].id, svc: null, party: 0, res: res ?? null, date: null, time: null }) };
    }
    return page(b, 'Book', `<h1>What would you like to book?</h1><p>${usable.map((c) => `<a class="btn s" href="${esc(bookLink({ s: c.id, svc: null, party: 0, res: res ?? null, date: null, time: null }))}">${esc(c.label)}</a>`).join(' ')}</p>`);
}

/**
 * The workspace's booking link, or null when it has none yet: a Website Assistant site (not
 * archived, not taken offline) with an address, and bookings set up. Its own domain once live.
 */
export async function bookingLinkFor(db: Db, orgId: number, now = new Date()): Promise<string | null> {
    // Read on every chat turn (loadProductsBlock): a minute's cache per workspace.
    const hit = linkCache.get(orgId);
    if (hit && hit.until > now.getTime()) return hit.link;
    const link = await findBookingLink(db, orgId, now);
    if (linkCache.size > 500) linkCache.clear();
    linkCache.set(orgId, { link, until: now.getTime() + 60_000 });
    return link;
}
const linkCache = new Map<number, { link: string | null; until: number }>();

async function findBookingLink(db: Db, orgId: number, now: Date): Promise<string | null> {
    const rows = await db.select({ id: sites.id, slug: sites.slug, status: sites.status, draft: sites.draft })
        .from(sites).innerJoin(aiAssistants, eq(aiAssistants.id, sites.aiAssistantId))
        .where(and(eq(sites.organisationId, orgId), isNotNull(sites.slug), ne(sites.status, 'suspended'), isNull(aiAssistants.archivedAt)))
        .orderBy(desc(sites.publishedAt), desc(sites.id)).limit(5);
    const site = rows.find((r) => r.status === 'published') ?? rows[0];
    if (!site?.slug) return null;
    if (bookingsSwitchedOff(normaliseSiteDefinition(site.draft, { maxPages: 1000 }).definition)) return null;
    if (!(await bookableKinds(db, orgId, now)).length) return null;
    const own = await currentDomain(db, site.id).catch(() => null);
    const origin = own?.status === 'live' ? `https://${own.domain}` : siteOrigin(site.slug);
    return `${origin}${BOOKING_PAGE_PATH}`;
}

/**
 * The line every drafting assistant reads (org-products.ts loadProductsBlock). '' when there is no
 * link: a business may book through something else (a Calendly button on its site), so "none" must
 * not become "you can't book". Pure.
 */
export function describeBookingLink(link: string | null): string {
    return link
        ? `Online booking link: ${link} — where customers book. When a post, email or follow-up asks people to book, use exactly this address; never make up another booking address.`
        : '';
}

/**
 * The booking link as a QR code (SVG, black on white, a quiet border) — for a counter card, a flyer,
 * a shop window. Null when it can't be drawn. Never throws.
 */
export async function bookingQrSvg(link: string): Promise<string | null> {
    try {
        const QR = await import('qrcode');
        const toString = (QR as unknown as { toString: typeof import('qrcode').toString }).toString ?? (QR as unknown as { default: typeof import('qrcode') }).default.toString;
        return await toString(link, { type: 'svg', margin: 2, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
    } catch (err) {
        console.error('[site-booking-page] QR code not drawn', err instanceof Error ? err.message : err);
        return null;
    }
}
