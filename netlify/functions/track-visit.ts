// netlify/functions/track-visit.ts — counts one public page view for the growth funnel.
//
//   POST { path, ref?, utmSource?, utmCampaign?, src?, cmp? } → 200 { source, campaign }
//
// Called by visit-count.js on the marketing pages. The reply tells the page which source to carry on
// its links (so a sign-up can be credited) — that is the only thing that survives the page.
//
// Privacy (owner, 2026-10-31; privacy.html §12): no cookie is read or set, and the IP address and user
// agent are never stored — the user agent is read once, here, to skip crawlers. A view becomes +1 on a
// daily total in site_visit_counts. Unauthenticated by design; the worst a forged request can do is
// nudge a count, so every field is bounded (src/utils/visit-source.ts) rather than rate-limited
// (the shared limiter keys on the IP, which this endpoint promises not to keep).
//
// Until db/z-growth-funnel.sql is applied the count is skipped and the page still gets its source.
// ⚠️ Always 200 with a JSON body: a 204 with body '' becomes a 502 under withLambda.

import { sql } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { siteVisitCounts } from '../../db/schema';
import { classifyVisit, isBot } from '../../src/utils/visit-source';

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body),
});

function isMissingTable(err: unknown): boolean {
    const e = err as { code?: string; cause?: { code?: string } };
    return e?.code === '42P01' || e?.cause?.code === '42P01';
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
    if ((event.body || '').length > 2000) return json(400, { error: 'Too large.' });
    let body: Record<string, unknown>;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid request.' }); }

    const visit = classifyVisit({
        path: body.path, ref: body.ref, utmSource: body.utmSource, utmCampaign: body.utmCampaign, src: body.src, cmp: body.cmp,
    });
    if (!visit) return json(200, { source: null, campaign: '' });
    const reply = { source: visit.source, campaign: visit.campaign };
    if (isBot(event.headers['user-agent'])) return json(200, reply);

    try {
        await getDb().insert(siteVisitCounts).values({
            // The UK day, so a late-evening visit lands on the day the owner would call it.
            day: sql`(now() AT TIME ZONE 'Europe/London')::date` as unknown as string,
            path: visit.path, source: visit.source, campaign: visit.campaign,
            views: 1, entries: visit.entry ? 1 : 0,
        }).onConflictDoUpdate({
            target: [siteVisitCounts.day, siteVisitCounts.path, siteVisitCounts.source, siteVisitCounts.campaign],
            set: {
                views: sql`${siteVisitCounts.views} + 1`,
                entries: sql`${siteVisitCounts.entries} + ${visit.entry ? 1 : 0}`,
            },
        });
    } catch (err) {
        if (!isMissingTable(err)) console.error('[track-visit] count failed', err);
    }
    return json(200, reply);
});
