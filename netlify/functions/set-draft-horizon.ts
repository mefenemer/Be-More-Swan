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
import { and, eq, gt, inArray } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { getDb, withTenant } from '../../db/client';
import { aiAssistants, blogPosts, masterAssistants, scheduledPosts } from '../../db/schema';
import { createNotification } from '../../src/utils/notify';
import { getSession } from '../../src/utils/session';
import { resolveActiveOrg } from '../../src/utils/tenant';
import { enqueueScheduleGapFill } from '../../src/utils/schedule-gap-fill';
import { enqueueBlogGapFill } from '../../src/utils/blog-gap-fill';
import { BLOG_WRITER_ROLE_KEYS, SMM_ROLE_KEYS } from '../../src/constants/roles';
import { resolveHorizonDays, MIN_HORIZON_DAYS, MAX_HORIZON_DAYS } from '../../src/config/posting-cadence';
import { withLambda } from '@netlify/aws-lambda-compat';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const MIN_HORIZON = MIN_HORIZON_DAYS;
const MAX_HORIZON = MAX_HORIZON_DAYS;

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

export default withLambda(async (event) => {
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
                // Which autopilot engine owns this assistant — social and blog keep separate
                // queues and separate draft tables, so the horizon change has to route.
                roleKey: masterAssistants.roleKey,
            })
            .from(aiAssistants)
            .innerJoin(masterAssistants, eq(aiAssistants.masterAssistantId, masterAssistants.id))
            .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, orgId)))
            .limit(1);
        return row ?? null;
    });

    if (!assistant) {
        return { statusCode: 404, body: JSON.stringify({ error: 'Assistant not found.' }) };
    }

    const isBlogWriter = BLOG_WRITER_ROLE_KEYS.includes(assistant.roleKey ?? '');
    const previousHorizon = resolveHorizonDays(assistant);
    const isExpanding = days > previousHorizon;
    const isShrinking = days < previousHorizon;

    // Persist the new horizon value (RLS-enforced — only the org's own row is updatable).
    // The column is the source of truth; the onboarding_context key of the same name is a legacy
    // echo that nothing reads (see DEFAULT_HORIZON_DAYS in posting-cadence.ts). It is rewritten here
    // anyway so the two can never disagree: update-assistant-context.ts promotes that key back onto
    // the column, and callers spread existing context into partial saves, so a stale echo left
    // behind would silently undo this change on the next unrelated save.
    await withTenant(orgId, (tx) => tx.update(aiAssistants)
        .set({
            draftHorizonDays: days,
            onboardingContext: {
                ...((assistant.onboardingContext as Record<string, unknown> | null) ?? {}),
                draft_horizon_days: days,
            },
            updatedAt: new Date(),
        })
        .where(eq(aiAssistants.id, assistantId)));

    // ── Horizon expanded → fill the newly-opened window immediately ───────────
    let gapFillEnqueued = 0;
    if (isExpanding) {
        const common = {
            id: assistant.id,
            userId: assistant.userId ?? userId,
            organisationId: orgId,
            name: assistant.name,
            onboardingContext: assistant.onboardingContext,
            draftHorizonDays: days,
        };
        // Exhaustive role routing, for the reason spelled out in update-assistant-context.ts: the
        // social gap-fill judges an assistant against a POSTING schedule, which only a Social Media
        // Manager has. Anything else falls through to its own engine (or to none).
        const result = isBlogWriter
            ? await enqueueBlogGapFill(db, common)
            : SMM_ROLE_KEYS.includes(assistant.roleKey ?? '')
                ? await enqueueScheduleGapFill(db, { ...common, configuration: assistant.configuration })
                : { enqueued: 0 };
        gapFillEnqueued = result.enqueued;

        if (gapFillEnqueued > 0) {
            const newWindowEnd = new Date();
            newWindowEnd.setDate(newWindowEnd.getDate() + days);
            const toDate = newWindowEnd.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
            await createNotification(db, 'draft_horizon_expanded', {
                userId,
                context: { assistant: { name: assistant.name }, horizon: {
                    draft_count: `${gapFillEnqueued} new draft${gapFillEnqueued === 1 ? '' : 's'}`,
                    to_date: toDate,
                } },
                metadata: { assistantId },
            });
        }
    }

    // ── Horizon shrunk → archive pending drafts beyond new cutoff ────────────
    if (isShrinking) {
        const newCutoff = new Date();
        newCutoff.setDate(newCutoff.getDate() + days);

        // Blog drafts live in their own table with their own status vocabulary: blog_posts has no
        // 'cancelled' (the status check constraint would reject it) and no cancelledAt /
        // rejectionReason columns, so the long-form equivalent is 'archived'.
        const archived = isBlogWriter
            ? await db.update(blogPosts)
                .set({ status: 'archived', updatedAt: new Date() })
                .where(and(
                    eq(blogPosts.assistantId, assistantId),
                    eq(blogPosts.organisationId, orgId),
                    inArray(blogPosts.status, ['draft', 'pending_approval']),
                    gt(blogPosts.publishDate, newCutoff),
                ))
                .returning({ id: blogPosts.id })
            : await db.update(scheduledPosts)
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
            await createNotification(db, 'draft_horizon_shrunk', {
                userId,
                context: { horizon: {
                    archived_count: `${archived.length} unreviewed draft${archived.length === 1 ? '' : 's'}`,
                    days,
                } },
                metadata: { assistantId },
            });
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
});
