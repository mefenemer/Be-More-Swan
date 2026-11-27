// netlify/functions/zoom-deauthorize.ts — Zoom tells us when someone removes the Note Taker's Zoom app
// (Zoom requires this "deauthorization notification endpoint" for a published app; src/utils/zoom-bot.ts).
//
//   POST endpoint.url_validation → { plainToken, encryptedToken }   (Zoom's check when the URL is saved)
//   POST app_deauthorized        → the Zoom connection of that Zoom user is deleted in every workspace that holds it
//
// Signed by Zoom with the app's secret token (ZOOM_WEBHOOK_SECRET_TOKEN, Zoom app → Features → Access → Secret Token).
// With no secret set it refuses everything (fails closed). Minutes already written stay the customer's.
// Logs workspace ids only, never Zoom ids or emails.

import { withLambda } from '@netlify/aws-lambda-compat';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { workspaceIntegrations } from '../../db/schema';
import { deleteIntegration } from '../../src/utils/workspace-integrations';
import { verifyZoomWebhook, zoomUrlValidation } from '../../src/utils/zoom-bot';

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });
    const secretToken = process.env.ZOOM_WEBHOOK_SECRET_TOKEN || '';
    if (!secretToken) {
        console.warn('[zoom-deauthorize] no ZOOM_WEBHOOK_SECRET_TOKEN set — refusing.');
        return json(503, { error: 'Not configured.' });
    }
    // The signature is over the exact bytes Zoom sent.
    const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(event.headers || {})) headers[k.toLowerCase()] = v ?? undefined;
    if (!verifyZoomWebhook(secretToken, headers, raw)) return json(401, { error: 'Bad signature.' });

    let payload: { event?: unknown; payload?: { plainToken?: unknown; user_id?: unknown } };
    try { payload = JSON.parse(raw); } catch { return json(400, { error: 'Invalid JSON.' }); }

    if (payload.event === 'endpoint.url_validation' && typeof payload.payload?.plainToken === 'string') {
        return json(200, zoomUrlValidation(secretToken, payload.payload.plainToken));
    }
    if (payload.event !== 'app_deauthorized') return json(200, { ok: true, ignored: true });
    const zoomUserId = typeof payload.payload?.user_id === 'string' ? payload.payload.user_id : '';
    if (!zoomUserId) return json(200, { ok: true, ignored: true });

    const db = getDb();
    try {
        const rows = await db.select({ organisationId: workspaceIntegrations.organisationId }).from(workspaceIntegrations)
            .where(and(eq(workspaceIntegrations.provider, 'zoom'), eq(workspaceIntegrations.tenantId, zoomUserId)));
        for (const r of rows) await deleteIntegration(db, r.organisationId, 'zoom');
        console.log('[zoom-deauthorize] disconnected', { workspaces: rows.map((r) => r.organisationId) });
        return json(200, { ok: true });
    } catch (err) {
        // A 5xx makes Zoom retry, which is what we want when the database blinked.
        console.error('[zoom-deauthorize] failed', err instanceof Error ? err.message : err);
        return json(500, { error: 'Could not disconnect.' });
    }
});
