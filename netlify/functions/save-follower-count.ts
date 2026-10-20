// netlify/functions/save-follower-count.ts
// Group A / Request 0: record a manually-entered follower count.
// POST { platform, count } → inserts a new dated row in manual_follower_counts.
//
// Manual entry is intentionally restricted to platforms whose API cannot supply a follower count.
// Today that is LinkedIn only (personal-profile follower counts aren't exposed by the member API).
// Each save is a NEW row, so periodic entries build a dated history; get-follower-counts reads the
// latest as the current count — and so does the LinkedIn Followers goal, which this re-polls on save.

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { and, eq } from 'drizzle-orm';
import { goals, manualFollowerCounts } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { pollOneGoal } from './poll-goal-telemetry';

// Platforms for which manual entry is allowed. Keep in sync with the manual-input UI gating.
const MANUAL_PLATFORMS = new Set(['linkedin']);

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId, organisationId } = ctx;
    if (!organisationId) return { statusCode: 400, body: JSON.stringify({ error: 'No organisation.' }) };

    let platform: string; let count: number;
    try {
        const body = JSON.parse(event.body || '{}');
        platform = String(body.platform || '').toLowerCase();
        count = Number(body.count);
    } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }

    if (!MANUAL_PLATFORMS.has(platform)) {
        return { statusCode: 400, body: JSON.stringify({ error: `Manual follower counts aren't supported for ${platform || 'that platform'}.` }) };
    }
    if (!Number.isFinite(count) || count < 0 || count > 2_000_000_000) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Enter a whole number of followers.' }) };
    }

    const recordedAt = new Date();
    await db.insert(manualFollowerCounts).values({
        organisationId,
        platform,
        count: Math.floor(count),
        recordedAt,
        enteredBy: userId ?? null,
    });

    // The LinkedIn Followers goal is measured FROM this figure (poll-goal-telemetry.ts), so move it
    // now rather than on the next hourly sweep — otherwise the Audience card says 1,240 while the
    // goal beside it still reads the old number, which is the double-entry this link removed.
    // Best-effort: the figure is saved either way, and the sweep catches up.
    let goalsUpdated = 0;
    if (platform === 'linkedin') {
        try {
            const liGoals = await db.select().from(goals).where(and(
                eq(goals.organisationId, organisationId),
                eq(goals.isActive, true),
                eq(goals.metricKey, 'linkedin_followers'),
            ));
            for (const goal of liGoals) {
                const outcome = await pollOneGoal(db, goal, {
                    conns: { byService: new Map(), li: null },   // this metric needs no connection token
                    cadenceMs: 0,
                    now: recordedAt,
                    force: true,
                });
                if (outcome === 'polled') goalsUpdated++;
            }
        } catch (err) {
            console.warn('[save-follower-count] LinkedIn goal refresh failed:', err instanceof Error ? err.message : err);
        }
    }

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true, platform, count: Math.floor(count), recordedAt: recordedAt.toISOString(), goalsUpdated }),
    };
});
