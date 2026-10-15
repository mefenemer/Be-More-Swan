// netlify/functions/site-preview.ts
// The editor's live preview of a DRAFT site — the real renderer (site-render.ts), signed-in only,
// never indexed. GET ?assistantId=<id>&path=/contact → text/html.
//
// Served from the app's own origin into an iframe on the Website tab. That is safe because the
// rendered page carries no JavaScript at all (site-render.ts), and the response's Content-Security-
// Policy forbids scripts outright and lets only our own app frame it.
// Internal links are mapped back onto this preview, so clicking around the preview stays in it.

import { and, eq, sql } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { aiAssistants, sites } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { WEBSITE_ASSISTANT_ROLE_KEY } from '../../src/constants/roles';
import { renderSitePage } from '../../src/utils/site-render';
import { definitionOf, maxPagesFor } from '../../src/utils/site-store';
import { loadSiteForms } from '../../src/utils/site-forms';
import { loadSiteProducts } from '../../src/utils/site-shop';
import { loadSiteReviews } from '../../src/utils/reviews';
import { bookingSummary, businessSummary } from '../../src/utils/bookings';
import { siteAssetUrl } from '../../src/utils/site-hosting';
import { resolveBaseUrl } from '../../src/utils/base-url';

const CSP = "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'";

function page(status: number, html: string) {
    return {
        statusCode: status,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP, 'X-Frame-Options': 'SAMEORIGIN', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' },
        body: html,
    };
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return page(401, '<p>Sign in to see your preview.</p>');

    const q = event.queryStringParameters || {};
    const id = Number(q.assistantId);
    if (!Number.isInteger(id) || id <= 0) return page(400, '<p>Missing assistant.</p>');
    const [row] = await db.select({ site: sites }).from(sites)
        .innerJoin(aiAssistants, eq(aiAssistants.id, sites.aiAssistantId))
        .where(and(
            eq(sites.aiAssistantId, id), eq(sites.organisationId, ctx.organisationId),
            sql`(${aiAssistants.configuration} ->> 'type') = ${WEBSITE_ASSISTANT_ROLE_KEY}`,
        )).limit(1);
    if (!row) return page(404, '<p>No site yet.</p>');

    const { definition } = definitionOf(row.site, await maxPagesFor(db, ctx.organisationId));
    const path = typeof q.path === 'string' && q.path.startsWith('/') ? q.path : '/';
    const self = (p: string) => `/.netlify/functions/site-preview?assistantId=${id}&path=${encodeURIComponent(p)}`;
    const rendered = renderSitePage(definition, path, {
        origin: 'https://preview.invalid',
        preview: true,
        reportUrl: '#',
        creditUrl: row.site.credit ? 'https://bemoreswan.com' : null,
        pagePath: self,
        assetUrl: (aid: number) => siteAssetUrl(resolveBaseUrl(event.headers as Record<string, string | undefined>) || 'https://bemoreswan.com', aid),
        // Sign-up sections draw their form (switched off — the preview's CSP forbids posting anyway).
        forms: await loadSiteForms(db, ctx.organisationId, definition),
        products: await loadSiteProducts(db, ctx.organisationId, definition),
        booking: await bookingSummary(db, ctx.organisationId),
        business: await businessSummary(db, ctx.organisationId),
        reviews: await loadSiteReviews(db, ctx.organisationId, definition),
    });
    return page(rendered.status, rendered.html);
});
