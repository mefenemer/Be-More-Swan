// netlify/functions/sites.ts
// The Website Assistant's API — the ONE server path the editor (src/components/assistant-site-editor.js)
// and the chat cards (chat-session.js → site:apply / site:draft) both use. docs/website-assistant-plan.md §5.5.
//
// POST { action, … }
//   get    { assistantId }                    → the draft definition, what the gate changed, the page cap,
//                                               placeholders still to fill, whether an AI draft is running
//   apply  { assistantId, ops: SiteOperation[] } → all or nothing; refused with the reason and which op
//   draft  { assistantId, request? }          → start an AI draft of the whole site (1 task, on success)
//   address   { assistantId, slug }           → choose / change <slug>.bemoreswan.site
//   publish   { assistantId }                 → freeze the draft as the next version and make it live
//   unpublish { assistantId }                 → take the site offline (versions kept)
//   versions  { assistantId }                 → the earlier published versions
//   restore   { assistantId, version }        → copy an earlier version into the DRAFT (not live)
//   enquiries { assistantId }                 → messages sent from the site's contact sections
//   enquiry_done { assistantId, id, done }    → mark one dealt with (or not)
//   payments_connect { assistantId }          → Stripe's onboarding link for the workspace's Standard
//                                               account (created the first time). Owner/admin only.
//   payments_refresh { assistantId }          → re-read the account from Stripe (back from onboarding)
//   words     { assistantId, pageId, text? | file?: {name, type, data(base64)} | attachmentId? |
//               quote? + chatSessionId?, note? }   (attachmentId / quote: the chat's site_words card)
//                                             → "Add your own words": a PROPOSAL placing the owner's
//                                               text on the page WORD FOR WORD (site-words.ts). Saves
//                                               nothing — Apply sends its ops through `apply`. 1 task.
//   products_import { assistantId, sectionId } → an older products section's typed-in items become
//                                               Business Information products; the section then names them
//   bookings  { assistantId }                 → bookings from the last 30 days on (bookings.ts)
//   booking_decide { assistantId, id, decision: confirm|decline|cancel } → the owner's decision; the
//                                               customer is emailed (a calendar invite on confirm)
//   booking_setup { assistantId, settings, section?: { pageId, kind, serviceIds, askStaff } }
//                                             → the chat's "Set up bookings" card: hours & rules saved
//                                               to Business Information, and a booking section added
//   orders    { assistantId }                 → paid orders from the site's Buy buttons
//   order_done { assistantId, id, done }      → mark one dealt with (or not)
//   enquiry_to_audience { assistantId, id, agreed: true } → the owner adds an enquirer who agreed
//   calendar  { assistantId, from, to }       → the Calendar tab: hours, free times, classes, bookings
//   split_preview { assistantId }             → the pages split_pages WOULD make (nothing saved), for
//                                               the "Several pages" approval; or why it can't
//
// address / publish / unpublish / restore are buttons on the Website tab's Publish card ONLY — the
// chat cards never send them (chat-session.js sends only apply and draft), so the owner always
// decides what goes live. Publishing refuses [placeholders] and runs the safety check on every word.

import { bookingCalendar, cleanRange, MAX_CALENDAR_DAYS } from '../../src/utils/booking-calendar';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { aiAssistants } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { enforcePromptModeration } from '../../src/utils/moderation';
import { WEBSITE_ASSISTANT_ROLE_KEY } from '../../src/constants/roles';
import { applySiteOperation, assetIdsIn, FEATURE_LABELS, FEATURE_SECTIONS, planSplit, SECTION_TYPES, SITE_FEATURES, type SiteOperation } from '../../src/utils/site-definition';
import { placeholdersIn } from '../../src/utils/site-draft';
import { cleanSiteSlugInput, siteAssetUrl, siteOrigin, sitesDomain, siteVisibleText, suggestSiteSlug } from '../../src/utils/site-hosting';
import { listSignupForms } from '../../src/utils/site-forms';
import { readWordsFile } from '../../src/utils/site-words';
import { attachmentText, quoteFromChat } from '../../src/utils/chat-attachments';
import { connectAccountFor, connectOnboardingLink, markOrderDone, refreshConnectAccount } from '../../src/utils/site-shop';
import { audienceContacts, bookings, bookingSettings, orgProducts, orgReviews, siteEnquiries, siteOrders, users } from '../../db/schema';
import { addEnquirerToAudience } from '../../src/utils/enquiry-audience';
import { decideBooking, describeBooking, emailCustomer, listBookings, loadBookingSetup } from '../../src/utils/bookings';
import { cleanBookingSettings, describeHours } from '../../src/utils/booking-settings';
import { purgeCache } from '@netlify/functions';
import { siteCacheTag } from '../../src/utils/site-hosting';

/**
 * Clear a site's cached pages so a publish (or taking it down) shows at once, not after the 60-second
 * cache. Never fails the action: at worst the change appears a minute later.
 */
async function purgeSitePages(slug: string | null | undefined): Promise<void> {
    if (!slug) return;
    try { await purgeCache({ tags: [siteCacheTag(slug)] }); }
    catch (err) { console.error('[sites] cache purge failed (the change shows within a minute)', err instanceof Error ? err.message : err); }
}
import { reviewSummary } from '../../src/utils/reviews';
import { depositNote, refundDeposit } from '../../src/utils/booking-deposits';
import { reconcileSoon } from '../../src/utils/calendar-microsoft';
import { addSessions, cancelSessions, cleanNewSessions, offerFreedPlaces, ownerTimetable } from '../../src/utils/class-sessions';
import { utcToZoned } from '../../src/utils/booking-time';
import { sessionLink } from '../../src/utils/site-render';
import { buyablePence, priceDisplay } from '../../src/utils/product-price';
import { resolveBaseUrl } from '../../src/utils/base-url';
import {
    applySiteOperations, claimDraft, definitionOf, endDraft, hasUnpublishedChanges, listSiteVersions, loadOrCreateSite, maxPagesFor,
    proposeOwnWords, publishBlocker, publishSite, restoreVersionToDraft, setSiteAddress, unpublishSite, DRAFT_TIMEOUT_MS, type SiteRow,
} from '../../src/utils/site-store';
import { triggerSiteDraft } from '../../src/utils/trigger-site-draft';

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

const MAX_OPS = 25;
const OP_NAMES = ['add_page', 'update_page', 'remove_page', 'add_section', 'update_section', 'remove_section', 'move_section', 'set_nav', 'set_theme', 'set_settings', 'set_footer', 'set_structure', 'combine_pages', 'split_pages'];

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId, userId, role } = ctx;

    let body: Record<string, unknown>;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
    const action = String(body.action || '');

    // IDOR + role guard: only THIS organisation's Website Assistant.
    const id = Number(body.assistantId);
    if (!Number.isInteger(id) || id <= 0) return json(400, { error: 'assistantId required.' });
    const [assistant] = await db.select({ id: aiAssistants.id }).from(aiAssistants).where(and(
        eq(aiAssistants.id, id), eq(aiAssistants.organisationId, orgId),
        sql`(${aiAssistants.configuration} ->> 'type') = ${WEBSITE_ASSISTANT_ROLE_KEY}`,
    )).limit(1);
    if (!assistant) return json(404, { error: 'Assistant not found.' });

    const maxPages = await maxPagesFor(db, orgId);
    let site = await loadOrCreateSite(db, { orgId, assistantId: assistant.id, userId });

    const view = async (s: SiteRow, extraWarnings: string[] = []) => {
        const { definition, warnings } = definitionOf(s, maxPages);
        const drafting = !!s.draftingAt && Date.now() - new Date(s.draftingAt).getTime() < DRAFT_TIMEOUT_MS;
        return {
            site: {
                id: s.id, status: s.status, credit: s.credit, drafting, draftNote: s.draftNote, updatedAt: s.updatedAt,
                slug: s.slug, url: s.slug ? siteOrigin(s.slug) : null, domain: sitesDomain(),
                suggestedSlug: s.slug ? null : suggestSiteSlug(definition.settings.siteName),
                publishedVersion: s.publishedVersion, publishedAt: s.publishedAt,
                unpublishedChanges: s.status === 'published' ? await hasUnpublishedChanges(db, s, maxPages) : false,
                // Home holds sections that would sit better on their own pages (the "Spread across pages" offer).
                canSplit: planSplit(definition.pages[0]?.sections ?? []).parts.length > 0,
                suspendedReason: s.status === 'suspended' ? (s.suspendedReason || 'Taken offline by Be More Swan.') : null,
                publishBlocker: publishBlocker(s, definition),
            },
            definition, warnings: [...new Set([...warnings, ...extraWarnings])], maxPages,
            placeholders: placeholdersIn(definition),
            // Thumbnails for the editor's picture fields: library picture id → its link.
            assetUrls: Object.fromEntries(assetIdsIn(definition).map((id) => [id, siteAssetUrl(resolveBaseUrl(event.headers as Record<string, string | undefined>) || 'https://bemoreswan.com', id)])),
            forms: await listSignupForms(db, orgId),
            // Business Information ▸ Products & Services — the ONE place products and prices live.
            catalogue: (await db.select({
                id: orgProducts.id, name: orgProducts.name, kind: orgProducts.kind, price: orgProducts.price,
                priceType: orgProducts.priceType, priceAmount: orgProducts.priceAmount, imageAssetId: orgProducts.imageAssetId,
            }).from(orgProducts).where(and(eq(orgProducts.organisationId, orgId), eq(orgProducts.status, 'active')))
                .orderBy(asc(orgProducts.sortOrder), asc(orgProducts.id)))
                .map((r) => ({ id: r.id, name: r.name, kind: r.kind, price: r.price, buyable: buyablePence(r) !== null,
                    imageUrl: r.imageAssetId ? siteAssetUrl(resolveBaseUrl(event.headers as Record<string, string | undefined>) || 'https://bemoreswan.com', r.imageAssetId) : null })),
            // Business Information ▸ Reviews — the customers' words, for the reviews section's picker.
            reviews: await (async () => {
                const rows = await db.select({ id: orgReviews.id, authorName: orgReviews.authorName, rating: orgReviews.rating, body: orgReviews.body, status: orgReviews.status, source: orgReviews.source, reviewedOn: orgReviews.reviewedOn })
                    .from(orgReviews).where(and(eq(orgReviews.organisationId, orgId), inArray(orgReviews.status, ['published', 'hidden'])))
                    .orderBy(desc(orgReviews.reviewedOn), desc(orgReviews.id));
                return { summary: reviewSummary(rows), list: rows.filter((r) => r.status === 'published').map((r) => ({ id: r.id, authorName: r.authorName, rating: r.rating, body: r.body.slice(0, 140), source: r.source, reviewedOn: r.reviewedOn })) };
            })(),
            payments: await (async () => {
                const acct = await connectAccountFor(db, orgId);
                return { connected: !!acct, chargesEnabled: !!acct?.chargesEnabled, detailsSubmitted: !!acct?.detailsSubmitted, canConnect: role === 'owner' || role === 'admin' };
            })(),
            booking: await (async () => {
                const b = await loadBookingSetup(db, orgId);
                const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(bookings).where(and(eq(bookings.organisationId, orgId), eq(bookings.status, 'pending')));
                return {
                    ready: Object.keys(b.settings.weeklyHours).length > 0, hours: describeHours(b.settings.weeklyHours), mode: b.settings.mode,
                    visitAddress: b.settings.visitAddress, whatsapp: b.settings.whatsapp,
                    services: b.services.map((x) => ({ id: x.id, name: x.name, durationMinutes: x.durationMinutes, price: x.price })),
                    resources: b.resources.map((r) => ({ id: r.id, name: r.name, kind: r.kind })), waiting: Number(n),
                };
            })(),
            newOrders: Number((await db.select({ n: sql<number>`count(*)::int` }).from(siteOrders)
                .where(and(eq(siteOrders.siteId, s.id), eq(siteOrders.status, 'paid'))))[0]?.n ?? 0),
            newEnquiries: Number((await db.select({ n: sql<number>`count(*)::int` }).from(siteEnquiries)
                .where(and(eq(siteEnquiries.siteId, s.id), eq(siteEnquiries.status, 'new'))))[0]?.n ?? 0),
            vocab: { sectionTypes: SECTION_TYPES, features: SITE_FEATURES.map((key) => ({ key, label: FEATURE_LABELS[key], sections: FEATURE_SECTIONS[key] })) },
        };
    };

    if (action === 'get') return json(200, await view(site));

    if (action === 'split_preview') {
        const r = applySiteOperation(definitionOf(site, maxPages).definition, { op: 'split_pages' }, { maxPages });
        if (!r.ok) return json(200, { pages: null, reason: r.error });
        return json(200, { pages: r.definition.pages.map((p) => ({ title: p.title, path: p.slug ? `/${p.slug}` : '/', sections: p.sections.length })) });
    }

    if (action === 'apply') {
        const ops = Array.isArray(body.ops) ? body.ops : [];
        if (!ops.length) return json(400, { error: 'Nothing to change.' });
        if (ops.length > MAX_OPS) return json(400, { error: `Up to ${MAX_OPS} changes at a time.` });
        if (ops.some((o) => !o || typeof o !== 'object' || !OP_NAMES.includes(String((o as { op?: unknown }).op)))) return json(400, { error: 'Unknown change.' });
        const r = await applySiteOperations(db, site, ops as SiteOperation[], maxPages);
        if (!r.ok) return json(400, { error: r.error, index: r.index });
        return json(200, await view(r.site, r.warnings));
    }

    if (action === 'draft') {
        const request = typeof body.request === 'string' ? body.request.trim().slice(0, 2000) : '';
        if (request) {
            const blocked = await enforcePromptModeration({ text: request, userId, organisationId: orgId, source: 'sites' });
            if (blocked) return blocked;
        }
        if (!(await claimDraft(db, site.id))) return json(409, { error: 'Your site is already being drafted — it will appear here in a minute or two.' });
        if (!(await triggerSiteDraft(site.id, request || null))) {
            await endDraft(db, site.id, 'The draft couldn\'t be started. Nothing was charged — try again.');
            return json(503, { error: 'The draft couldn\'t be started. Nothing was charged — try again.' });
        }
        site = (await loadOrCreateSite(db, { orgId, assistantId: assistant.id, userId }));
        return json(202, await view(site));
    }

    if (action === 'address') {
        const slug = cleanSiteSlugInput(body.slug);
        if (site.status === 'suspended') return json(409, { error: 'This site has been taken offline by Be More Swan.' });
        const old = site.slug;
        const r = await setSiteAddress(db, site, slug);
        if (!r.ok) return json(400, { error: r.error });
        await purgeSitePages(old);   // the old address must stop showing the site at once
        return json(200, await view(r.site));
    }

    if (action === 'publish') {
        const { definition } = definitionOf(site, maxPages);
        const blocker = publishBlocker(site, definition);
        if (blocker) return json(400, { error: blocker });
        // The safety check reads every word a visitor would read. A hard block is logged for review.
        const blocked = await enforcePromptModeration({ text: siteVisibleText(definition).slice(0, 20000), userId, organisationId: orgId, source: 'site_publish' });
        if (blocked) return blocked;
        const r = await publishSite(db, site, userId, maxPages);
        if (!r.ok) return json(400, { error: r.error });
        await purgeSitePages(r.site.slug);
        return json(200, await view(r.site));
    }

    if (action === 'unpublish') {
        const down = await unpublishSite(db, site);
        await purgeSitePages(site.slug);
        return json(200, await view(down));
    }

    if (action === 'versions') return json(200, { versions: await listSiteVersions(db, site.id), publishedVersion: site.publishedVersion });

    if (action === 'enquiries') {
        // Every enquiry, newest first — the list pages itself in the browser.
        const rows = await db.select({
            id: siteEnquiries.id, name: siteEnquiries.name, email: siteEnquiries.email, phone: siteEnquiries.phone,
            message: siteEnquiries.message, pagePath: siteEnquiries.pagePath, status: siteEnquiries.status, createdAt: siteEnquiries.createdAt,
            // Whether they are in the Audience, and as what (enquiry-audience.ts) — null when not.
            audienceStatus: audienceContacts.status,
        }).from(siteEnquiries)
            .leftJoin(audienceContacts, and(eq(audienceContacts.organisationId, orgId), sql`${audienceContacts.email} = lower(trim(${siteEnquiries.email}))`))
            .where(and(eq(siteEnquiries.siteId, site.id), eq(siteEnquiries.organisationId, orgId))).orderBy(desc(siteEnquiries.createdAt));
        return json(200, { enquiries: rows });
    }

    // The owner adds an enquirer to the Audience, saying they agreed (enquiry-audience.ts: manual_entry).
    if (action === 'enquiry_to_audience') {
        if (body.agreed !== true) return json(400, { error: 'Only add someone who has agreed to receive your emails.' });
        const [q] = await db.select({ id: siteEnquiries.id, name: siteEnquiries.name, email: siteEnquiries.email }).from(siteEnquiries)
            .where(and(eq(siteEnquiries.id, Number(body.id)), eq(siteEnquiries.siteId, site.id), eq(siteEnquiries.organisationId, orgId))).limit(1);
        if (!q) return json(404, { error: 'Enquiry not found.' });
        const r = await addEnquirerToAudience(db, { organisationId: orgId, email: q.email, name: q.name, enquiryId: q.id, by: { userId } });
        if (r.result === 'no_email') return json(400, { error: 'That email address can\'t be used.' });
        if (r.result === 'already' && r.status !== 'subscribed') return json(200, { ok: true, note: `They're already in your Audience, and stay ${r.status} — someone who said stop is never re-subscribed.` });
        return json(200, { ok: true, note: r.result === 'added' ? 'Added to your Audience.' : 'They were already in your Audience.' });
    }

    if (action === 'enquiry_done') {
        const eid = Number(body.id);
        const [row] = await db.update(siteEnquiries).set({ status: body.done === false ? 'new' : 'done' })
            .where(and(eq(siteEnquiries.id, eid), eq(siteEnquiries.siteId, site.id), eq(siteEnquiries.organisationId, orgId))).returning({ id: siteEnquiries.id });
        if (!row) return json(404, { error: 'Enquiry not found.' });
        return json(200, { ok: true });
    }

    if (action === 'payments_connect') {
        if (role !== 'owner' && role !== 'admin') return json(403, { error: 'Only the workspace owner or an admin can connect a Stripe account.' });
        const base = resolveBaseUrl(event.headers as Record<string, string | undefined>) || 'https://bemoreswan.com';
        const back = `${base}/workspace.html?view=assistant-detail&assistantId=${assistant.id}&tab=siteorders&payments=return`;
        const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
        try {
            const url = await connectOnboardingLink(db, { orgId, userId, email: u?.email ?? null, returnUrl: back, refreshUrl: back });
            return json(200, { url });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error('[sites] Stripe connect failed', msg);
            // Our own Stripe platform isn't set up for Connect (e.g. the platform profile questionnaire,
            // 2026-10-16): nothing the business can fix — say so rather than "try again".
            if (/platform profile|connect.*(not enabled|isn't enabled)|signed up for connect/i.test(msg)) {
                return json(503, { error: 'Taking payments isn\'t available just yet — Be More Swan is finishing its set-up with Stripe. Please try again later today.' });
            }
            return json(503, { error: 'Stripe couldn\'t be reached just now. Try again in a minute.' });
        }
    }

    if (action === 'payments_refresh') {
        try { await refreshConnectAccount(db, orgId); } catch (err) { console.error('[sites] Stripe refresh failed', err instanceof Error ? err.message : err); }
        return json(200, await view(site));
    }

    if (action === 'words') {
        const pageId = String(body.pageId || '');
        const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 500) : null;
        let text = typeof body.text === 'string' ? body.text : '';
        const file = body.file && typeof body.file === 'object' ? body.file as { name?: unknown; type?: unknown; data?: unknown } : null;
        if (file && typeof file.data === 'string') {
            try {
                const fromFile = await readWordsFile(String(file.name || ''), String(file.type || ''), Buffer.from(file.data, 'base64'));
                text = text ? `${text}\n\n${fromFile}` : fromFile;
            } catch (err) {
                return json(400, { error: err instanceof Error ? err.message : 'That file couldn\'t be read.' });
            }
        }
        // From the chat's site_words card: an attached document's words, or words the assistant quoted
        // from the owner's own message — accepted only if they really are in it (chat-attachments.ts).
        const attachmentId = Number(body.attachmentId);
        if (Number.isInteger(attachmentId) && attachmentId > 0) {
            const fromAttachment = await attachmentText(db, orgId, attachmentId);
            if (!fromAttachment) return json(404, { error: 'That attached document isn\'t available any more. Attach it again.' });
            text = text ? `${text}\n\n${fromAttachment}` : fromAttachment;
        } else if (typeof body.quote === 'string' && body.quote.trim()) {
            const fromChat = await quoteFromChat(db, orgId, Number(body.chatSessionId), body.quote);
            if (!fromChat) return json(400, { error: 'Those words weren\'t found in your messages, so they weren\'t used. Paste them again, or use "Add your own words" on the Website tab.' });
            text = text ? `${text}\n\n${fromChat}` : fromChat;
        }
        const blocked = await enforcePromptModeration({ text: `${text}\n${note ?? ''}`.slice(0, 20000), userId, organisationId: orgId, source: 'site_words' });
        if (blocked) return blocked;
        const r = await proposeOwnWords(db, site, { pageId, text, note, maxPages });
        if (!r.ok) return json(r.status, { error: r.error });
        return json(200, { proposal: r.proposal });
    }

    if (action === 'products_import') {
        // Items typed into a products section before products moved to Business Information: each
        // becomes a Business Information product (its price as a fixed price), and the section names them.
        const sectionId = String(body.sectionId || '');
        const { definition } = definitionOf(site, maxPages);
        const page = definition.pages.find((pg) => pg.sections.some((x) => x.id === sectionId));
        const section = page?.sections.find((x) => x.id === sectionId);
        if (!page || !section || section.type !== 'products' || !section.props.items.length) return json(404, { error: 'There\'s nothing to move in that section.' });
        const [{ maxOrder }] = await db.select({ maxOrder: sql<number>`coalesce(max(${orgProducts.sortOrder}), -1)::int` }).from(orgProducts).where(eq(orgProducts.organisationId, orgId));
        const created = await db.insert(orgProducts).values(section.props.items.map((it, i) => ({
            organisationId: orgId, createdBy: userId ?? null, kind: 'product', status: 'active', sortOrder: maxOrder + 1 + i,
            name: it.name.slice(0, 120), description: it.description,
            ...(it.price !== null ? { priceType: 'fixed', priceAmount: it.price, price: priceDisplay({ priceType: 'fixed', priceAmount: it.price, priceUnit: null }) } : {}),
            imageAssetId: it.image?.assetId ?? null,
        }))).returning({ id: orgProducts.id });
        const r = await applySiteOperations(db, site, [{ op: 'update_section', pageId: page.id, sectionId, props: { productIds: created.map((c) => c.id), items: [] } }], maxPages);
        if (!r.ok) return json(400, { error: r.error });
        return json(200, await view(r.site, [`${created.length} item${created.length === 1 ? '' : 's'} moved into Business Information ▸ Products & Services. Change prices there from now on.`]));
    }

    // The Calendar tab: hours, free times, classes (n of N) and bookings for a month (booking-calendar.ts).
    if (action === 'calendar') {
        const range = cleanRange(body.from, body.to);
        if (!range) return json(400, { error: `Choose up to ${MAX_CALENDAR_DAYS} days.` });
        return json(200, await bookingCalendar(db, orgId, range, new Date()));
    }

    if (action === 'bookings') {
        const setup = await loadBookingSetup(db, orgId);
        const rows = await listBookings(db, orgId);
        return json(200, { bookings: rows.map((b) => ({ ...describeBooking(b, setup.settings.timezone), id: b.id, status: b.status, customerName: b.customerName,
            customerEmail: b.customerEmail, customerPhone: b.customerPhone, notes: b.notes, partySize: b.partySize, startsAt: b.startsAt, createdAt: b.createdAt,
            cancelledBy: b.cancelledBy, moved: b.movedFromId !== null, reminded: b.reminderSentAt !== null, deposit: depositNote(b) }))
            // An unpaid deposit hold that lapsed was never a booking: left out.
            .filter((b, i) => !(rows[i].paymentStatus === 'expired')) });
    }

    // ── Classes and events (class-sessions.ts): the timetable ──
    if (action === 'timetable') {
        return json(200, { sessions: await ownerTimetable(db, orgId, new Date()) });
    }
    if (action === 'session_add') {
        const setup = await loadBookingSetup(db, orgId);
        const today = utcToZoned(new Date(), setup.settings.timezone).date;
        const cleaned = cleanNewSessions((body.session && typeof body.session === 'object' ? body.session : {}) as Record<string, unknown>, today);
        if (!cleaned.ok) return json(400, { error: cleaned.error });
        const r = await addSessions(db, orgId, cleaned.value);
        if (!r.ok) return json(400, { error: r.error });
        await reconcileSoon(db, orgId);
        return json(200, { added: r.value.length, sessions: await ownerTimetable(db, orgId, new Date()) });
    }
    if (action === 'session_cancel') {
        const setup = await loadBookingSetup(db, orgId);
        const { definition } = definitionOf(site, maxPages);
        const r = await cancelSessions(db, orgId, Number(body.id), body.wholeSeries === true, new Date());
        if (!r.sessions.length) return json(409, { error: 'That session has already been cancelled.' });
        const [owner] = await db.select({ email: users.email }).from(aiAssistants).leftJoin(users, eq(users.id, aiAssistants.userId)).where(eq(aiAssistants.id, assistant.id)).limit(1);
        const ctx = { business: definition.settings.siteName, timezone: setup.settings.timezone, assistantId: assistant.id, cancellationPolicy: setup.settings.cancellationPolicy, siteOrigin: site.slug ? siteOrigin(site.slug) : null };
        for (const b of r.bookings) {
            if (b.status === 'cancelled' && b.paymentStatus === 'paid') b.paymentStatus = await refundDeposit(db, b) === 'refunded' ? 'refunded' : 'refund_failed';
            // An unpaid hold had told nobody yet, so there is nobody to tell.
            if (b.paymentStatus === 'unpaid') continue;
            await emailCustomer(b, 'cancelled', ctx, owner?.email ?? null);
        }
        await reconcileSoon(db, orgId);
        return json(200, { cancelled: r.sessions.length, told: r.bookings.length, sessions: await ownerTimetable(db, orgId, new Date()) });
    }

    if (action === 'booking_decide') {
        const decision = body.decision === 'confirm' || body.decision === 'decline' || body.decision === 'cancel' ? body.decision : null;
        if (!decision) return json(400, { error: 'Confirm, decline or cancel?' });
        const setup = await loadBookingSetup(db, orgId);
        const { definition } = definitionOf(site, maxPages);
        const r = await decideBooking(db, orgId, Number(body.id), decision, {
            business: definition.settings.siteName, timezone: setup.settings.timezone, assistantId: assistant.id, cancellationPolicy: setup.settings.cancellationPolicy,
            siteOrigin: site.slug ? siteOrigin(site.slug) : null,
        });
        if (!r.ok) return json(409, { error: r.error });
        // A class place given back (declined or cancelled): offer it to the waitlist.
        if (r.booking.sessionId && r.booking.status !== 'confirmed' && site.slug) {
            const cls = definition.pages.flatMap((pg) => pg.sections).find((x) => x.type === 'booking' && x.props.kind === 'class');
            if (cls) await offerFreedPlaces(db, orgId, r.booking.sessionId, { business: definition.settings.siteName, siteOrigin: siteOrigin(site.slug), bookPath: (sid) => sessionLink(cls.id, sid) });
        }
        return json(200, { ok: true, status: r.booking.status });
    }

    if (action === 'booking_setup') {
        // The chat's card, after the owner's click: hours & rules into Business Information, then
        // (optionally) a booking section on a page. Both through their usual gates.
        const raw = body.settings && typeof body.settings === 'object' ? body.settings as Record<string, unknown> : {};
        const cleaned = cleanBookingSettings(raw);
        if (!cleaned.ok) return json(400, { error: cleaned.error });
        if (Object.keys(cleaned.value).length) {
            const values = { ...cleaned.value, updatedAt: new Date() };
            await db.insert(bookingSettings).values({ organisationId: orgId, ...values }).onConflictDoUpdate({ target: bookingSettings.organisationId, set: values });
        }
        const sec = body.section && typeof body.section === 'object' ? body.section as Record<string, unknown> : null;
        if (sec && typeof sec.pageId === 'string') {
            const r = await applySiteOperations(db, site, [{ op: 'add_section', pageId: sec.pageId, section: { type: 'booking', props: {
                kind: sec.kind, serviceIds: sec.serviceIds, askStaff: sec.askStaff, heading: sec.heading ?? (sec.kind === 'table' ? 'Book a table' : 'Book an appointment'),
            } } }], maxPages);
            if (!r.ok) return json(400, { error: r.error });
            site = r.site;
        }
        return json(200, await view(site, ['Bookings are set up. Change your hours and rules any time in Business Information ▸ Hours, location & bookings.']));
    }

    if (action === 'orders') {
        const rows = await db.select({
            id: siteOrders.id, itemName: siteOrders.itemName, quantity: siteOrders.quantity, amountTotal: siteOrders.amountTotal, currency: siteOrders.currency,
            customerName: siteOrders.customerName, customerEmail: siteOrders.customerEmail, shippingAddress: siteOrders.shippingAddress,
            status: siteOrders.status, createdAt: siteOrders.createdAt,
        }).from(siteOrders).where(and(eq(siteOrders.siteId, site.id), eq(siteOrders.organisationId, orgId))).orderBy(desc(siteOrders.createdAt));
        return json(200, { orders: rows });
    }

    if (action === 'order_done') {
        if (!(await markOrderDone(db, orgId, site.id, Number(body.id), body.done !== false))) return json(404, { error: 'Order not found.' });
        return json(200, { ok: true });
    }

    if (action === 'restore') {
        const version = Number(body.version);
        if (!Number.isInteger(version) || version <= 0) return json(400, { error: 'Which version?' });
        const restored = await restoreVersionToDraft(db, site, version, maxPages);
        if (!restored) return json(404, { error: 'That version is no longer kept.' });
        return json(200, await view(restored));
    }

    return json(400, { error: 'Unknown action.' });
});
