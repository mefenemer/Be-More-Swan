// netlify/functions/canva-import-status.ts
// Canva connector, US3: progress polling for an in-flight import.
//
//   GET ?jobIds=1,2,3  → { jobs: [{ jobId, designId, designTitle, status, assetIds, errorMessage }] }
//
// Org-scoped: a job id from another organisation simply doesn't come back, so the response can
// never leak another tenant's import.

import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { canvaImportJobs } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { withLambda } from '@netlify/aws-lambda-compat';

const MAX_JOBS_PER_POLL = 50;

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId } = ctx;

    const raw = (event.queryStringParameters?.jobIds || '').trim();
    const jobIds = raw.split(',')
        .map(s => Number(s.trim()))
        .filter(n => Number.isInteger(n) && n > 0)
        .slice(0, MAX_JOBS_PER_POLL);

    if (!jobIds.length) return json(400, { error: 'Missing jobIds' });

    const rows = await db.select({
        jobId: canvaImportJobs.id,
        designId: canvaImportJobs.designId,
        designTitle: canvaImportJobs.designTitle,
        status: canvaImportJobs.status,
        assetIds: canvaImportJobs.resultAssetIds,
        errorMessage: canvaImportJobs.errorMessage,
    })
        .from(canvaImportJobs)
        .where(and(
            eq(canvaImportJobs.organisationId, organisationId),
            inArray(canvaImportJobs.id, jobIds),
        ));

    return json(200, { jobs: rows });
});
