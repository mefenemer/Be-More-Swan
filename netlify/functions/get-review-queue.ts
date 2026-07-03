// netlify/functions/get-review-queue.ts
// US-SMM-2.4.2: Returns posts pending review for an assistant, ordered by publish date,
// with urgency bands (green/amber/red) and a dashboard summary widget payload.
//
// GET /.netlify/functions/get-review-queue?assistantId=N[&tab=pending|missed]
//   Auth: aura_session cookie

import { Handler } from '@netlify/functions';
import { and, asc, eq, sql } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { getDb } from '../../db/client';
import { aiAssistants, scheduledPosts } from '../../db/schema';
import { getSession } from '../../src/utils/session';
import { resolveActiveOrg } from '../../src/utils/tenant';
import { requireOnboarding } from '../../src/utils/onboarding-guard';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

const URGENCY_RED_HOURS    = 12;
const URGENCY_AMBER_HOURS  = 48;

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

function urgencyBadge(publishDate: Date, now: Date): 'green' | 'amber' | 'red' {
    const hoursRemaining = (publishDate.getTime() - now.getTime()) / (1000 * 60 * 60);
    if (hoursRemaining < URGENCY_RED_HOURS)   return 'red';
    if (hoursRemaining < URGENCY_AMBER_HOURS) return 'amber';
    return 'green';
}

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    const userId = getUserId(event);
    if (!userId) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorised.' }) };
    }

    const params      = event.queryStringParameters || {};
    const assistantId = params.assistantId ? Number(params.assistantId) : null;
    const tab         = params.tab || 'pending'; // 'pending' | 'missed'

    if (!assistantId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'assistantId is required.' }) };
    }

    const db = getDb();

    // US3 (AC3.1/AC3.2): block the Review Queue until onboarding is complete.
    const denied = await requireOnboarding(db, userId);
    if (denied) return denied;

    // Resolve the active organisation (member-shared assistant ownership; membership verified).
    const org = await resolveActiveOrg(db, userId, getSession(event)?.activeOrganisationId);
    if (!org) return { statusCode: 403, body: JSON.stringify({ error: 'No organisation associated with this account.' }) };
    const orgId = org.organisationId;

    // Verify the assistant belongs to the active organisation
    const [assistant] = await db
        .select({ id: aiAssistants.id, reviewCutoffHours: aiAssistants.reviewCutoffHours })
        .from(aiAssistants)
        .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, orgId)))
        .limit(1);

    if (!assistant) {
        return { statusCode: 404, body: JSON.stringify({ error: 'Assistant not found.' }) };
    }

    const now = new Date();

    if (tab === 'missed') {
        const missedPosts = await db
            .select()
            .from(scheduledPosts)
            .where(and(
                eq(scheduledPosts.assistantId, assistantId),
                eq(scheduledPosts.status, 'missed'),
            ))
            .orderBy(asc(scheduledPosts.publishDate));

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tab: 'missed', posts: missedPosts }),
        };
    }

    // Pending review tab — statuses that need human action
    const pendingPosts = await db
        .select()
        .from(scheduledPosts)
        .where(and(
            eq(scheduledPosts.assistantId, assistantId),
            sql`status IN ('draft','in_review','approved')`,
        ))
        .orderBy(asc(scheduledPosts.publishDate));

    const now_ = now;
    const postsWithUrgency = pendingPosts.map(post => {
        const urgency = urgencyBadge(new Date(post.publishDate), now_);
        const hoursRemaining = Math.max(0, (new Date(post.publishDate).getTime() - now_.getTime()) / (1000 * 60 * 60));
        return {
            ...post,
            urgency,
            hoursRemaining: Math.round(hoursRemaining * 10) / 10,
            isPinned: urgency === 'red',
        };
    }).sort((a, b) => {
        // Red posts pinned to top, then by publishDate
        if (a.urgency === 'red' && b.urgency !== 'red') return -1;
        if (a.urgency !== 'red' && b.urgency === 'red') return 1;
        return new Date(a.publishDate).getTime() - new Date(b.publishDate).getTime();
    });

    // Dashboard summary widget payload
    const redCount   = postsWithUrgency.filter(p => p.urgency === 'red').length;
    const nextPost   = postsWithUrgency[0] ?? null;
    const nextDueIn  = nextPost
        ? `${nextPost.hoursRemaining}h`
        : null;

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            tab: 'pending',
            posts: postsWithUrgency,
            summary: {
                totalPending: postsWithUrgency.length,
                redZoneCount: redCount,
                nextPostDueIn: nextDueIn,
                reviewCutoffHours: assistant.reviewCutoffHours,
            },
        }),
    };
};
