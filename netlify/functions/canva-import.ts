// netlify/functions/canva-import.ts
// Canva connector, US3: start an import of selected Canva designs into the Content Library.
//
//   POST { designs: [{ id, title }] }  → validate → create job rows → trigger worker → { jobIds }
//
// Returns 202 once the background worker has been dispatched (the trigger POST returns as soon as
// Netlify accepts the invocation, before the work runs). The real work — export, poll, download,
// R2, content_assets — runs in canva-import-background, and the picker polls canva-import-status
// for progress. See triggerWorker for why the dispatch must be awaited.
//
// The batch is capped because Canva rate-limits export creation hard (20/min, 75/5min, 500/24h per
// user). The worker throttles too, but refusing an oversized selection up front gives the user a
// clear error instead of a batch that half-fails ten minutes later.

import { getDb } from '../../db/client';
import { canvaImportJobs } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { getIntegration } from '../../src/utils/workspace-integrations';
import { withLambda } from '@netlify/aws-lambda-compat';

const MAX_DESIGNS_PER_IMPORT = 20;

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

// Kick the background worker. MUST be awaited: this runs on AWS Lambda, which freezes the
// execution environment the instant the handler returns. An un-awaited fetch (the old
// fire-and-forget pattern) gets frozen mid-flight and the request never actually reaches the
// worker, so the jobs sit 'queued' forever and the picker spins until it times out. Posting to a
// -background function returns 202 immediately — before the 15-min work runs — so awaiting adds
// only the trigger round-trip. The AbortController caps that so a stalled trigger can't hold the
// client's request open. Returns whether the worker was successfully dispatched.
async function triggerWorker(headers: Record<string, string | undefined>, jobIds: number[]): Promise<boolean> {
    const baseUrl = resolveBaseUrl(headers);
    if (!baseUrl) { console.error('[canva-import] no base URL — worker not triggered for jobs', jobIds); return false; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
        const res = await fetch(`${baseUrl}/.netlify/functions/canva-import-background`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobIds }),
            signal: controller.signal,
        });
        return res.ok;
    } catch (err) {
        console.error('[canva-import] failed to trigger worker:', err);
        return false;
    } finally {
        clearTimeout(timer);
    }
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId, organisationId } = ctx;

    let body: any;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Invalid JSON' }); }

    const designs: Array<{ id?: unknown; title?: unknown; designType?: unknown }> = Array.isArray(body.designs) ? body.designs : [];
    const cleaned = designs
        .map(d => ({
            id: String(d?.id ?? '').trim(),
            title: String(d?.title ?? '').trim(),
            // Advisory only — it just picks the export format, and the worker defaults to png.
            // Nothing here trusts it, so passing it from the client is safe.
            designType: d?.designType ? String(d.designType).trim().slice(0, 60) : '',
        }))
        .filter(d => d.id);

    if (!cleaned.length) return json(400, { error: 'Select at least one design to import.' });
    if (cleaned.length > MAX_DESIGNS_PER_IMPORT) {
        return json(400, { error: `You can import up to ${MAX_DESIGNS_PER_IMPORT} designs at a time — you selected ${cleaned.length}.` });
    }

    // Fail fast on a disconnected Canva rather than queueing jobs that are certain to fail. The
    // worker resolves the actual token; this is only a "is there a connection at all" gate.
    const integration = await getIntegration(db, organisationId, 'canva');
    if (!integration || integration.status !== 'active') {
        return json(409, { error: 'Canva is not connected — connect it before importing.', code: 'not_connected' });
    }

    const rows = await db.insert(canvaImportJobs).values(
        cleaned.map(d => ({
            organisationId,
            userId,
            designId: d.id,
            designTitle: d.title || null,
            designType: d.designType || null,
            status: 'queued' as const,
        })),
    ).returning({ id: canvaImportJobs.id, designId: canvaImportJobs.designId });

    const dispatched = await triggerWorker(event.headers as Record<string, string | undefined>, rows.map(r => r.id));
    if (!dispatched) {
        // The rows are queued but the worker was never reached, so nothing will ever process them.
        // Tell the client now rather than letting the picker poll a stuck import until it times out.
        return json(502, { error: 'Could not start the import — please try again in a moment.' });
    }

    return json(202, { jobs: rows.map(r => ({ jobId: r.id, designId: r.designId })) });
});
