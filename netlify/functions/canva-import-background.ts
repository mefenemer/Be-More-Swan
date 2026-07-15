// netlify/functions/canva-import-background.ts
// Canva connector, US3: background worker that imports selected Canva designs into the Content
// Library.
//
// POST { jobIds }  — for each canva_import_jobs row: create a Canva export job, poll it to
// success, download each resulting page into R2, and insert a content_assets row per page
// (provider 'canva'). Marks each job completed/failed independently, so one bad design does not
// sink the batch.
//
// Netlify background functions (filename ends in `-background`) run async with a 15-minute
// ceiling. Triggered fire-and-forget by canva-import.ts.
//
// TOKEN HANDLING — read this before refactoring.
// The access token is resolved ONCE for the whole batch and threaded through every export.
// getFreshAccessToken does an unguarded read → refresh → store, and Canva refresh tokens are
// single-use and always rotate. Two concurrent callers therefore both POST the same refresh
// token; Canva accepts one and rejects the other, and the loser's error handler marks the
// integration 'expired' — killing Canva for the whole org even though the winner just refreshed
// successfully. Calling it once up front means no refresh happens mid-batch (access tokens far
// outlive a 12-minute run), which is what makes the bounded concurrency below safe.
// Do not move getFreshAccessToken inside the per-design loop.

import { HandlerEvent } from '@netlify/functions';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { canvaImportJobs, contentAssets } from '../../db/schema';
import { getFreshAccessToken, IntegrationError } from '../../src/utils/workspace-integrations';
import { persistRemoteMediaToR2, r2IsConfigured } from '../../src/lib/media-persist';
import { withLambda } from '@netlify/aws-lambda-compat';

const CANVA_API = 'https://api.canva.com/rest/v1';
const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;   // 10 min, under the 15-min background ceiling
// Canva allows 20 export creates/min per user. Three at a time keeps us well inside that while
// still being meaningfully faster than serial for a big selection.
const CONCURRENCY = 3;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

type Db = ReturnType<typeof getDb>;

interface ExportedPage { url: string; contentType: string; }

// Canva's design_type does NOT cleanly say "this is a video" — it returns things like doc,
// presentation, whiteboard, custom, unknown. So this is a deliberate best-effort match on the
// types that are known to be motion, defaulting to png for everything else. A still exported
// from a video design is a recoverable disappointment; an mp4 export of a doc is an error.
function formatForDesign(designType: string | null): 'mp4' | 'png' {
    const t = (designType || '').toLowerCase();
    return /video|animation|reel|short/.test(t) ? 'mp4' : 'png';
}

function mimeForFormat(format: 'mp4' | 'png'): string {
    return format === 'mp4' ? 'video/mp4' : 'image/png';
}

/**
 * Create an export job and poll it to completion. Returns one entry per page.
 * `onExportId` fires as soon as Canva assigns an id, so a stuck export can be traced back to
 * the Canva side from the job row.
 */
async function exportDesign(
    accessToken: string,
    designId: string,
    format: 'mp4' | 'png',
    deadline: number,
    onExportId: (id: string) => Promise<void>,
): Promise<ExportedPage[]> {
    const createRes = await fetch(`${CANVA_API}/exports`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ design_id: designId, format: { type: format } }),
    });
    if (createRes.status === 429) throw new Error('Canva is rate-limiting exports — try a smaller selection in a minute.');
    if (!createRes.ok) throw new Error(`Canva refused to export this design (${createRes.status}).`);

    const created: any = await createRes.json().catch(() => ({}));
    const exportId = created?.job?.id;
    if (!exportId) throw new Error('Canva did not return an export job id.');
    await onExportId(String(exportId));

    while (true) {
        const pollRes = await fetch(`${CANVA_API}/exports/${encodeURIComponent(exportId)}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!pollRes.ok) throw new Error(`Could not read the export status from Canva (${pollRes.status}).`);
        const body: any = await pollRes.json().catch(() => ({}));
        const job = body?.job ?? {};

        if (job.status === 'success') {
            // Download URLs are valid for 24h — we persist the bytes, never the URL.
            const urls: string[] = Array.isArray(job.urls) ? job.urls : [];
            if (!urls.length) throw new Error('Canva reported the export succeeded but returned no files.');
            return urls.map(url => ({ url, contentType: mimeForFormat(format) }));
        }
        if (job.status === 'failed') {
            throw new Error(job.error?.message || 'Canva could not export this design.');
        }
        if (Date.now() > deadline) throw new Error('Canva took too long to export this design — please try again.');
        await sleep(POLL_INTERVAL_MS);
    }
}

/** Import one design: export → download each page → content_assets rows. */
async function importOne(db: Db, job: typeof canvaImportJobs.$inferSelect, accessToken: string, deadline: number): Promise<void> {
    const fail = async (message: string) => {
        await db.update(canvaImportJobs)
            .set({ status: 'failed', errorMessage: message, updatedAt: new Date() })
            .where(eq(canvaImportJobs.id, job.id));
    };

    try {
        // canva_import_jobs.user_id is ON DELETE SET NULL but content_assets.user_id is NOT NULL,
        // so a user deleted between queueing and importing would otherwise surface as an opaque
        // constraint violation. There is no sensible owner to fall back to — fail it clearly.
        if (job.userId == null) {
            await fail('The user who started this import no longer exists.');
            return;
        }

        // Claim the job by transitioning queued → processing. The status predicate is what makes
        // this a claim: a duplicate worker invocation finds the row already 'processing', updates
        // nothing, and returns instead of importing the design a second time.
        const claimed = await db.update(canvaImportJobs)
            .set({ status: 'processing', updatedAt: new Date() })
            .where(and(eq(canvaImportJobs.id, job.id), eq(canvaImportJobs.status, 'queued')))
            .returning({ id: canvaImportJobs.id });
        if (!claimed.length) return;

        const format = formatForDesign(job.designType);
        const pages = await exportDesign(accessToken, job.designId, format, deadline, async (exportId) => {
            await db.update(canvaImportJobs)
                .set({ exportJobId: exportId, updatedAt: new Date() })
                .where(eq(canvaImportJobs.id, job.id));
        });

        const title = job.designTitle || 'Canva design';
        const assetIds: number[] = [];

        for (let i = 0; i < pages.length; i++) {
            const page = pages[i];
            // Multi-page designs (presentations) export one file per page. Name them so the
            // library stays navigable rather than showing five identical titles.
            const name = pages.length > 1 ? `${title} (page ${i + 1})` : title;
            const stored = await persistRemoteMediaToR2({
                orgId: job.organisationId,
                url: page.url,
                contentType: page.contentType,
                folder: 'canva',
                label: 'Canva export',
            });
            const [asset] = await db.insert(contentAssets).values({
                userId: job.userId,
                organisationId: job.organisationId,
                name,
                assetType: format === 'mp4' ? 'video' : 'image',
                mimeType: page.contentType,
                fileSize: stored.fileSize,
                storageKey: stored.storageKey,
                provider: 'canva',
                providerAssetId: job.designId,
                // Reuses the stock-attribution field to hold the "open in Canva" deep link. Canva's
                // own design URLs are temporary, so build from the id rather than storing theirs.
                attributionUrl: `https://www.canva.com/design/${job.designId}/edit`,
                attributionName: 'Canva',
                status: 'pending',
            }).returning({ id: contentAssets.id });
            assetIds.push(asset.id);
        }

        await db.update(canvaImportJobs)
            .set({ status: 'completed', resultAssetIds: assetIds, updatedAt: new Date() })
            .where(eq(canvaImportJobs.id, job.id));
    } catch (err) {
        console.error(`[canva-import-background] job ${job.id} failed:`, err);
        await fail(err instanceof Error ? err.message : 'The import failed unexpectedly.').catch(() => {});
    }
}

export default withLambda(async (event: HandlerEvent) => {
    let jobIds: number[];
    try { jobIds = JSON.parse(event.body || '{}').jobIds; }
    catch { return { statusCode: 400, body: 'Invalid JSON' }; }
    if (!Array.isArray(jobIds) || !jobIds.length) return { statusCode: 400, body: 'Missing jobIds' };

    const db = getDb();

    try {
        const jobs = await db.select().from(canvaImportJobs).where(inArray(canvaImportJobs.id, jobIds));
        const pending = jobs.filter(j => j.status === 'queued');
        if (!pending.length) return { statusCode: 200, body: 'Nothing to do' };

        // Every job in a batch belongs to one org (canva-import creates them from one request).
        const organisationId = pending[0].organisationId;

        if (!r2IsConfigured()) {
            // Without R2 there is nowhere durable to put the bytes, and Canva's download URLs die
            // in 24h — importing would produce assets that silently break tomorrow. Fail loudly.
            await db.update(canvaImportJobs)
                .set({ status: 'failed', errorMessage: 'Media storage is not configured — imports are unavailable.', updatedAt: new Date() })
                .where(inArray(canvaImportJobs.id, pending.map(j => j.id)));
            return { statusCode: 200, body: 'R2 not configured' };
        }

        // Resolved once for the batch — see the token note at the top of this file.
        let accessToken: string;
        try {
            ({ accessToken } = await getFreshAccessToken(db, organisationId, 'canva'));
        } catch (err) {
            const message = err instanceof IntegrationError
                ? err.message
                : 'Could not authenticate with Canva — please reconnect it.';
            await db.update(canvaImportJobs)
                .set({ status: 'failed', errorMessage: message, updatedAt: new Date() })
                .where(inArray(canvaImportJobs.id, pending.map(j => j.id)));
            return { statusCode: 200, body: 'Token unavailable' };
        }

        const deadline = Date.now() + POLL_TIMEOUT_MS;
        const queue = [...pending];
        const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
            while (queue.length) {
                const job = queue.shift();
                if (job) await importOne(db, job, accessToken, deadline);
            }
        });
        await Promise.all(workers);

        return { statusCode: 200, body: 'Done' };
    } catch (err) {
        console.error('[canva-import-background] batch failed:', err);
        return { statusCode: 200, body: 'Failed' };
    }
});
