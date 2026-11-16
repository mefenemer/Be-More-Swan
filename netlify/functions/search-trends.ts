// netlify/functions/search-trends.ts
// The workspace's tracked search terms on Google Trends (docs/google-trends-plan.md Phase 2).
// Business Information ▸ What people search, Blog setup and the chat cards all use this.
//
// GET                                           → { trends: OrgTrend[], regions, defaultRegion, max }
// POST { action: 'add', term, region? }         → { ok, message, trends }
// POST { action: 'approve', termId }            → { ok, message, trends }
// POST { action: 'approve_all' }                → { ok, message, trends }
// POST { action: 'remove', termId }             → { ok, message, trends }
// POST { action: 'suggest' }                    → { ok, added, trends }   (Haiku; saved as suggestions)
// POST { action: 'lookup', term, region? }      → { ok, deferred, trend?, summary?, message? }   (Phase 3: Live
//                                                  look-up, fair_use_trends_lookups_per_day; over it = a suggestion)
//
// Every member may read. Viewers may not change the list. Costs no task: the weekly refresh is ours,
// and a suggestion is one small model call (plan §6, §10 Q5).

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { gatewayGenerate } from '../../src/lib/ai-gateway';
import { requireTenant } from '../../src/utils/tenant';
import { COUNTRY_LOCATION, countryLocation, dataForSeoProvider } from '../../src/lib/trends-provider';
import { checkFairUse } from '../../src/utils/fair-use';
import { FILTER_MODEL, lookupTrendTerm, MAX_TRACKED_PER_ORG, normaliseTerm, trackTrendTerm } from '../../src/utils/search-trends';
import { describeTrend, loadOrgTrends, loadSharedTrend } from '../../src/utils/search-trends-read';
import {
    applyTrendTermAction, defaultRegionIso, parseTrendTermAction, suggestTrendTerms, SUGGEST_MODEL, TREND_REGIONS,
} from '../../src/utils/search-trend-terms';

const json = (statusCode: number, body: unknown) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const haiku = (orgId: number, sessionId: string) => async (system: string, user: string) => (await gatewayGenerate({
    model: FILTER_MODEL, system, messages: [{ role: 'user', content: user }], maxTokens: 800,
    deadlineMs: 15_000, usage: { workspaceId: orgId, sessionId },
})).text;

/**
 * POST { action: 'lookup', term, region? } — Google Trends for one term NOW (plan §10 Q5). Free, under a
 * daily fair-use cap (fair_use_trends_lookups_per_day, 10). Over the cap — or with no provider — the term
 * is added as a suggestion so the weekly refresh picks it up once approved. Never tracks it by itself.
 */
async function lookup(db: ReturnType<typeof getDb>, orgId: number, userId: number, body: Record<string, unknown>): Promise<[number, unknown]> {
    const termText = typeof body.term === 'string' ? body.term : '';
    if (!normaliseTerm(termText)) return [400, { error: 'Type a search term of 1–80 characters.' }];
    const iso = typeof body.region === 'string' && COUNTRY_LOCATION[body.region.toUpperCase()] ? body.region.toUpperCase() : await defaultRegionIso(db, userId);
    const loc = countryLocation(iso);
    const provider = dataForSeoProvider();
    const fair = provider ? await checkFairUse(db, orgId, 'trends') : { allowed: false, message: undefined };
    if (!provider || !fair.allowed) {
        const t = await trackTrendTerm(db, orgId, { term: termText, locationCode: loc.code, locationName: loc.name, source: 'user', approved: false });
        const why = fair.message ?? 'Live look-ups aren’t available just now.';
        return [200, { ok: true, deferred: true, message: t.ok ? `${why} I’ve added “${normaliseTerm(termText)}” to your search terms as a suggestion — approve it and its data arrives with the weekly refresh.` : why }];
    }
    const r = await lookupTrendTerm(db, { term: termText, locationCode: loc.code, locationName: loc.name, organisationId: orgId }, { provider, callFilterModel: haiku(orgId, 'search-trends-lookup-filter') });
    if (!r.ok) return [502, { error: r.error }];
    const trend = await loadSharedTrend(db, r.termId);
    return [200, { ok: true, deferred: false, fromCache: r.fromCache, trend, summary: trend ? describeTrend(trend) : null }];
}

export default withLambda(async (event) => {
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;

    try {
        if (event.httpMethod === 'GET') {
            return json(200, {
                trends: await loadOrgTrends(db, ctx.organisationId),
                regions: TREND_REGIONS.map((r) => ({ iso: r.iso, name: r.name })),
                defaultRegion: await defaultRegionIso(db, ctx.userId),
                max: MAX_TRACKED_PER_ORG,
            });
        }
        if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
        if (ctx.role === 'viewer') return json(403, { error: 'Viewers can see the search terms but not change them.' });

        let body: Record<string, unknown> = {};
        try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request.' }); }

        if (body.action === 'suggest') {
            const r = await suggestTrendTerms(db, ctx.organisationId, ctx.userId, async (system, user) => (await gatewayGenerate({
                model: SUGGEST_MODEL, system, messages: [{ role: 'user', content: user }], maxTokens: 400,
                deadlineMs: 18_000, usage: { workspaceId: ctx.organisationId, userId: ctx.userId, sessionId: 'search-trends-suggest' },
            })).text);
            if (!r.ok) return json(400, { error: r.error });
            return json(200, { ok: true, added: r.added, trends: await loadOrgTrends(db, ctx.organisationId) });
        }

        if (body.action === 'lookup') return json(...await lookup(db, ctx.organisationId, ctx.userId, body));

        const action = parseTrendTermAction(body);
        if (!action) return json(400, { error: 'Unknown action.' });
        const r = await applyTrendTermAction(db, ctx.organisationId, ctx.userId, action);
        if (!r.ok) return json(r.status, { error: r.error });
        return json(200, r);
    } catch (err) {
        console.error('[search-trends]', err);
        return json(500, { error: 'Could not update your search terms. Try again.' });
    }
});
