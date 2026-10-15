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
//   orders    { assistantId }                 → paid orders from the site's Buy buttons
//   order_done { assistantId, id, done }      → mark one dealt with (or not)
//
// address / publish / unpublish / restore are buttons on the Website tab's Publish card ONLY — the
// chat cards never send them (chat-session.js sends only apply and draft), so the owner always
// decides what goes live. Publishing refuses [placeholders] and runs the safety check on every word.

import { and, desc, eq, sql } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { aiAssistants } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { enforcePromptModeration } from '../../src/utils/moderation';
import { WEBSITE_ASSISTANT_ROLE_KEY } from '../../src/constants/roles';
import { SECTION_TYPES, type SiteOperation } from '../../src/utils/site-definition';
import { placeholdersIn } from '../../src/utils/site-draft';
import { cleanSiteSlugInput, siteOrigin, sitesDomain, siteVisibleText, suggestSiteSlug } from '../../src/utils/site-hosting';
import { listSignupForms } from '../../src/utils/site-forms';
import { connectAccountFor, connectOnboardingLink, markOrderDone, refreshConnectAccount } from '../../src/utils/site-shop';
import { siteEnquiries, siteOrders, users } from '../../db/schema';
import { resolveBaseUrl } from '../../src/utils/base-url';
import {
    applySiteOperations, claimDraft, definitionOf, endDraft, hasUnpublishedChanges, listSiteVersions, loadOrCreateSite, maxPagesFor,
    publishBlocker, publishSite, restoreVersionToDraft, setSiteAddress, unpublishSite, DRAFT_TIMEOUT_MS, type SiteRow,
} from '../../src/utils/site-store';
import { triggerSiteDraft } from '../../src/utils/trigger-site-draft';

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

const MAX_OPS = 25;
const OP_NAMES = ['add_page', 'update_page', 'remove_page', 'add_section', 'update_section', 'remove_section', 'move_section', 'set_nav', 'set_theme', 'set_settings', 'set_footer'];

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
                suspendedReason: s.status === 'suspended' ? (s.suspendedReason || 'Taken offline by Be More Swan.') : null,
                publishBlocker: publishBlocker(s, definition),
            },
            definition, warnings: [...new Set([...warnings, ...extraWarnings])], maxPages,
            placeholders: placeholdersIn(definition),
            forms: await listSignupForms(db, orgId),
            payments: await (async () => {
                const acct = await connectAccountFor(db, orgId);
                return { connected: !!acct, chargesEnabled: !!acct?.chargesEnabled, detailsSubmitted: !!acct?.detailsSubmitted, canConnect: role === 'owner' || role === 'admin' };
            })(),
            newOrders: Number((await db.select({ n: sql<number>`count(*)::int` }).from(siteOrders)
                .where(and(eq(siteOrders.siteId, s.id), eq(siteOrders.status, 'paid'))))[0]?.n ?? 0),
            newEnquiries: Number((await db.select({ n: sql<number>`count(*)::int` }).from(siteEnquiries)
                .where(and(eq(siteEnquiries.siteId, s.id), eq(siteEnquiries.status, 'new'))))[0]?.n ?? 0),
            vocab: { sectionTypes: SECTION_TYPES },
        };
    };

    if (action === 'get') return json(200, await view(site));

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
        const r = await setSiteAddress(db, site, slug);
        if (!r.ok) return json(400, { error: r.error });
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
        return json(200, await view(r.site));
    }

    if (action === 'unpublish') return json(200, await view(await unpublishSite(db, site)));

    if (action === 'versions') return json(200, { versions: await listSiteVersions(db, site.id), publishedVersion: site.publishedVersion });

    if (action === 'enquiries') {
        // Every enquiry, newest first — the list pages itself in the browser.
        const rows = await db.select({
            id: siteEnquiries.id, name: siteEnquiries.name, email: siteEnquiries.email, phone: siteEnquiries.phone,
            message: siteEnquiries.message, pagePath: siteEnquiries.pagePath, status: siteEnquiries.status, createdAt: siteEnquiries.createdAt,
        }).from(siteEnquiries).where(and(eq(siteEnquiries.siteId, site.id), eq(siteEnquiries.organisationId, orgId))).orderBy(desc(siteEnquiries.createdAt));
        return json(200, { enquiries: rows });
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
        const back = `${base}/workspace.html?view=assistant-detail&assistantId=${assistant.id}&tab=sitebuilder&payments=return`;
        const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
        try {
            const url = await connectOnboardingLink(db, { orgId, userId, email: u?.email ?? null, returnUrl: back, refreshUrl: back });
            return json(200, { url });
        } catch (err) {
            console.error('[sites] Stripe connect failed', err instanceof Error ? err.message : err);
            return json(503, { error: 'Stripe couldn\'t be reached just now. Try again in a minute.' });
        }
    }

    if (action === 'payments_refresh') {
        try { await refreshConnectAccount(db, orgId); } catch (err) { console.error('[sites] Stripe refresh failed', err instanceof Error ? err.message : err); }
        return json(200, await view(site));
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
