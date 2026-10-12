// netlify/functions/data-export.ts
// US-GAP-2.2.1: Self-serve data export (GDPR portability; DPA v1.1 §9 "export your workspace data at
// any time from My Account"). The button is in My Account → My Agreements → "Your data".
//
//  GET  → the caller's latest export in the last 24h: { status, requestedAt, expiresAt, downloadUrl,
//         scope } — so the page can offer the download again without another request.
//  POST → queues an export and triggers data-export-background (which builds it, stores the file
//         and emails the link). Returns 202. One per person per 24 hours (SC5).
//
// What is in it lives in src/utils/workspace-export.ts. Owners and admins get the organisation's
// workspace data as well as their own; other members get their own records.

import * as crypto from 'crypto';
import { eq, and, desc, gte } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { dataExportRequests } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { requireOnboarding } from '../../src/utils/onboarding-guard';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { withLambda } from '@netlify/aws-lambda-compat';
import { checkImpersonationBlock } from '../../src/utils/impersonation';
import { EXPORT_WORKSPACE_ROLES, exportJobSignature } from '../../src/utils/workspace-export';

const DAY_MS = 24 * 60 * 60 * 1000;
/** A build that has not finished in this long died (background functions stop at 15 min). */
const STUCK_MS = 20 * 60 * 1000;

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export default withLambda(async (event) => {
    // US-ADM-1.2.1: never during an admin impersonation session (src/utils/impersonation.ts).
    const impersonationBlock = checkImpersonationBlock(event, 'data_export');
    if (impersonationBlock) return impersonationBlock;

    if (!['GET', 'POST'].includes(event.httpMethod)) return json(405, { error: 'Method Not Allowed' });

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;

    // US3 (AC3.1/AC3.2): Export is gated until onboarding is complete.
    const denied = await requireOnboarding(db, ctx.userId);
    if (denied) return denied;

    const includeWorkspace = EXPORT_WORKSPACE_ROLES.includes(ctx.role);

    const [recent] = await db
        .select()
        .from(dataExportRequests)
        .where(and(eq(dataExportRequests.userId, ctx.userId), gte(dataExportRequests.requestedAt, new Date(Date.now() - DAY_MS))))
        .orderBy(desc(dataExportRequests.requestedAt))
        .limit(1);

    // A build that never finished, or failed, must not hold the one-a-day slot.
    const stuck = recent && recent.status === 'pending' && Date.now() - new Date(recent.requestedAt).getTime() > STUCK_MS;
    const live = recent && !stuck && recent.status !== 'failed' ? recent : null;

    if (event.httpMethod === 'GET') {
        return json(200, {
            scope: includeWorkspace ? 'workspace' : 'personal',
            recentRequest: live ? {
                status: live.status,
                requestedAt: live.requestedAt,
                expiresAt: live.expiresAt,
                downloadUrl: live.status === 'ready' && live.downloadToken
                    ? `/.netlify/functions/data-export-download?token=${live.downloadToken}` : null,
            } : null,
            failed: !!recent && !live,
        });
    }

    // POST
    if (live) {
        return json(429, {
            error: live.status === 'ready'
                ? 'You already have an export from the last 24 hours — download it below.'
                : 'Your export is already being prepared.',
        });
    }

    const [row] = await db.insert(dataExportRequests).values({
        userId: ctx.userId,
        downloadToken: crypto.randomBytes(32).toString('hex'),
        status: 'pending',
    }).returning({ id: dataExportRequests.id });

    // Background function: acks 202 at once, then builds for up to 15 min. Awaited so the trigger is
    // delivered before this handler returns (a fire-and-forget fetch is dropped on Lambda freeze).
    const baseUrl = resolveBaseUrl(event.headers);
    let triggered = false;
    if (baseUrl) {
        try {
            const res = await fetch(`${baseUrl}/.netlify/functions/data-export-background`, {
                method: 'POST',
                body: JSON.stringify({
                    requestId: row.id, organisationId: ctx.organisationId, includeWorkspace,
                    sig: exportJobSignature(row.id, ctx.organisationId, includeWorkspace),
                }),
            });
            triggered = res.ok || res.status === 202;
        } catch (err) {
            console.error('[data-export] background trigger failed:', err);
        }
    }
    if (!triggered) {
        await db.update(dataExportRequests).set({ status: 'failed' }).where(eq(dataExportRequests.id, row.id));
        return json(502, { error: 'We couldn\'t start your export. Please try again in a minute.' });
    }

    return json(202, {
        success: true,
        scope: includeWorkspace ? 'workspace' : 'personal',
        message: 'Your export is being prepared. It usually takes a minute or two — we\'ll email you the link too.',
    });
});
