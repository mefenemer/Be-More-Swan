// netlify/functions/set-draft-horizon.ts
// US-SMM-2.4.1: Update the draft horizon (days ahead the assistant keeps the queue filled).
//
// PATCH /.netlify/functions/set-draft-horizon
//   Auth: aura_session cookie
//   Body: { assistantId: number, draftHorizonDays: number (1–30) }
//
// Side effects:
//   • Horizon increase → enqueues a gap-fill task run + notifies user of new drafts added
//   • Horizon decrease → archives pending drafts beyond new horizon with a note

import { Handler } from '@netlify/functions';
import { and, eq, gt } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { getDb, withTenant } from '../../db/client';
import { aiAssistants, notifications, scheduledPosts } from '../../db/schema';
import { getSession } from '../../src/utils/session';
import { resolveActiveOrg } from '../../src/utils/tenant';
import { enqueueScheduleGapFill } from '../../src/utils/schedule-gap-fill';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const MIN_HORIZON = 1;
const MAX_HORIZON = 30;

function getUserId(event: any): number | null {
    try {
        const cookie = event.headers.cookie || '';
        const match  = cookie.match(/aura_session=([^;]+)/);
        if (!match) return null;
        const payload: any = jwt.verify(match[1], JWT_SECRET);
        return payload.userId ?? null;
    } catch {
        return null;
    }
}

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'PATCH') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    const userId = getUserId(event);
    if (!userId) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorised.' }) };
    }

    let body: any = {};
    try { body = JSON.parse(event.body || '{}'); } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) };
    }

    const { assistantId, draftHorizonDays } = body;
    if (!assistantId || draftHorizonDays == null) {
        return { statusCode: 400, body: JSON.stringify({ error: 'assistantId and draftHorizonDays are required.' }) };
    }

    const days = Number(draftHorizonDays);
    if (!Number.isInteger(days) || days < MIN_HORIZON || days > MAX_HORIZON) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: `draftHorizonDays must be an integer between ${MIN_HORIZON} and ${MAX_HORIZON}.` }),
        };
    }

    const db = getDb();

    // Resolve the active organisation (member-shared assistant ownership; membership verified).
    const org = await resolveActiveOrg(db, userId, getSession(event)?.activeOrganisationId);
    if (!org) return { statusCode: 403, body: JSON.stringify({ error: 'No organisation associated with this account.' }) };
    const orgId = org.organisationId;

    // Load current assistant within the active organisation (RLS-enforced)
    const assistant = await withTenant(orgId, async (tx) => {
        const [row] = await tx
            .select({
                id: aiAssistants.id,
                userId: aiAssistants.userId,
                draftHorizonDays: aiAssistants.draftHorizonDays,
                name: aiAssistants.name,
                onboardingContext: aiAssistants.onboardingContext,
                configuration: aiAssistants.configuration,
            })
            .from(aiAssistants)
            .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, orgId)))
            .limit(1);
        return row ?? null;
    });

    if (!assistant) {
        return { statusCode: 404, body: JSON.stringify({ error: 'Assistant not found.' }) };
    }

    const previousHorizon = assistant.draftHorizonDays ?? 7;
    const isExpanding = days > previousHorizon;
    const isShrinking = days < previousHorizon;

    // Persist the new horizon value (RLS-enforced — only the org's own row is updatable)
    await withTenant(orgId, (tx) => tx.update(aiAssistants)
        .set({ draftHorizonDays: days, updatedAt: new Date() })
        .where(eq(aiAssistants.id, assistantId)));

    // ── Horizon expanded → fill the newly-opened window immediately ───────────
    let gapFillEnqueued = 0;
    if (isExpanding) {
        const result = await enqueueScheduleGapFill(db, {
            id: assistant.id,
            userId: assistant.userId ?? userId,
            organisationId: orgId,
            name: assistant.name,
            onboardingContext: assistant.onboardingContext,
            draftHorizonDays: days,
            configuration: assistant.configuration,
        });
        gapFillEnqueued = result.enqueued;

        if (gapFillEnqueued > 0) {
            const newWindowEnd = new Date();
            newWindowEnd.setDate(newWindowEnd.getDate() + days);
            const toDate = newWindowEnd.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
            await db.insert(notifications).values({
                userId,
                type: 'draft_horizon_expanded',
                title: 'Draft horizon extended',
                message: `${assistant.name} is generating ${gapFillEnqueued} new draft${gapFillEnqueued === 1 ? '' : 's'} to cover through ${toDate}. They'll appear in your Review Queue shortly.`,
            }).catch(() => {});
        }
    }

    // ── Horizon shrunk → archive pending drafts beyond new cutoff ────────────
    if (isShrinking) {
        const newCutoff = new Date();
        newCutoff.setDate(newCutoff.getDate() + days);

        const archived = await db.update(scheduledPosts)
            .set({
                status: 'cancelled',
                cancelledAt: new Date(),
                rejectionReason: 'Outside current draft horizon',
                updatedAt: new Date(),
            })
            .where(and(
                eq(scheduledPosts.assistantId, assistantId),
                eq(scheduledPosts.status, 'draft'),
                gt(scheduledPosts.publishDate, newCutoff),
            ))
            .returning({ id: scheduledPosts.id });

        if (archived.length > 0) {
            await db.insert(notifications).values({
                userId,
                type: 'draft_horizon_shrunk',
                title: 'Draft horizon shortened',
                message: `${archived.length} unreviewed draft${archived.length === 1 ? '' : 's'} beyond your new ${days}-day window have been moved to Archived Drafts.`,
            }).catch(() => {});
        }
    }

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            updated: true,
            draftHorizonDays: days,
            previousHorizonDays: previousHorizon,
            gapFillEnqueued,
        }),
    };
};
