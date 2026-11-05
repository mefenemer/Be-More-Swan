// netlify/functions/site-visit.ts — counts one page view on a published website (src/utils/site-visits.ts).
//
// Called ONLY by sites-host/edge-functions/serve.ts, after it has served a page to a person: the shared
// SITE_SERVE_SECRET proves it, as for site-serve. The edge has already left out bots, form posts and
// anything that isn't a page, and sends a one-way hash for the visitor — never an IP or browser string.
//
//   POST { host, path, ref, visitor }   (header x-site-serve-key)   → 200 { ok: true }
//
// ⚠️ 200 with a body, not 204: under withLambda a 204 with body '' turns into a 502.

import { timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { sites } from '../../db/schema';
import { resolveSiteHost } from '../../src/utils/site-domains';
import { countablePath, recordVisit } from '../../src/utils/site-visits';

const ok = (body: unknown = { ok: true }) => ({ statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });

function keyMatches(given: string | undefined, secret: string | undefined): boolean {
    if (!given || !secret) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(secret);
    return a.length === b.length && timingSafeEqual(a, b);
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    const h = event.headers as Record<string, string | undefined>;
    if (!keyMatches(h['x-site-serve-key'], process.env.SITE_SERVE_SECRET)) return { statusCode: 404, body: 'Not found' };
    let b: { host?: unknown; path?: unknown; ref?: unknown; visitor?: unknown } = {};
    try { b = JSON.parse(event.body || '{}'); } catch { return ok({ ok: false }); }
    const path = typeof b.path === 'string' ? b.path : '';
    if (!countablePath(path)) return ok({ ok: false });
    try {
        const db = getDb();
        const resolved = await resolveSiteHost(db, typeof b.host === 'string' ? b.host : '');
        // The address the visitor should be at (a redirect) is counted where they land, not here.
        if (!resolved?.slug || resolved.redirectTo) return ok({ ok: false });
        const [site] = await db.select({ id: sites.id, status: sites.status }).from(sites).where(eq(sites.slug, resolved.slug)).limit(1);
        if (!site || site.status !== 'published') return ok({ ok: false });
        await recordVisit(db, {
            siteId: site.id, path,
            refHost: typeof b.ref === 'string' && b.ref ? b.ref.slice(0, 100) : null,
            visitor: typeof b.visitor === 'string' ? b.visitor : '',
        });
        return ok();
    } catch (err) {
        // A count lost is never worth an error the edge would have to handle.
        console.error('[site-visit] not counted', err instanceof Error ? err.message : err);
        return ok({ ok: false });
    }
});
