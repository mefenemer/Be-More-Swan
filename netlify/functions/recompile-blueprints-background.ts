// netlify/functions/recompile-blueprints-background.ts
// Recompile every existing blueprint. Triggered when a plan price is applied (see
// src/utils/plan-pricing.ts → triggerBlueprintRecompile): a price change is a platform-wide
// event, so every assistant's compiled brief is refreshed from current data in one pass.
//
// Netlify background functions (filename ends in `-background`) run async with a 15-minute
// ceiling, so the per-assistant loop is safe here in a way it would not be inside the 26s
// request that applies the price. The caller gets a 202 the moment the work is accepted.
//
// Auth: Bearer CRON_TRIGGER_SECRET (same secret as the other internal `-background` triggers).

import { getDb } from '../../db/client';
import { aiBlueprints } from '../../db/schema';
import { assembleBlueprint } from '../../src/utils/blueprint';
import { withLambda } from '@netlify/aws-lambda-compat';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!secret) {
        console.warn('[recompile-blueprints-background] CRON_TRIGGER_SECRET is not set — trigger disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Trigger not configured.' }) };
    }

    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    if (auth.replace(/^Bearer\s+/i, '').trim() !== secret) {
        return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };
    }

    let reason = 'unspecified';
    try { reason = (JSON.parse(event.body || '{}').reason as string) || reason; } catch { /* keep default */ }

    const db = getDb();

    // Every assistant that already has a compiled brief. Recompiling means refreshing what exists —
    // assistants that were never compiled are left alone (nothing to recompile).
    const rows = await db.selectDistinct({ assistantId: aiBlueprints.assistantId }).from(aiBlueprints);

    let recompiled = 0;
    const failed: number[] = [];
    for (const { assistantId } of rows) {
        // Best-effort per assistant: one failure must not abort the rest of the sweep.
        try {
            await assembleBlueprint(assistantId, 'system', reason);
            recompiled++;
        } catch (err) {
            failed.push(assistantId);
            console.error(`[recompile-blueprints-background] assistant ${assistantId} failed:`, err instanceof Error ? err.message : err);
        }
    }

    console.log(`[recompile-blueprints-background] reason=${reason} recompiled=${recompiled}/${rows.length} failed=${failed.length}`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, total: rows.length, recompiled, failed }) };
});
