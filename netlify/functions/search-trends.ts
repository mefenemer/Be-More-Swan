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
//
// Every member may read. Viewers may not change the list. Costs no task: the weekly refresh is ours,
// and a suggestion is one small model call (plan §6, §10 Q5).

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { gatewayGenerate } from '../../src/lib/ai-gateway';
import { requireTenant } from '../../src/utils/tenant';
import { MAX_TRACKED_PER_ORG } from '../../src/utils/search-trends';
import { loadOrgTrends } from '../../src/utils/search-trends-read';
import {
    applyTrendTermAction, defaultRegionIso, parseTrendTermAction, suggestTrendTerms, SUGGEST_MODEL, TREND_REGIONS,
} from '../../src/utils/search-trend-terms';

const json = (statusCode: number, body: unknown) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

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
