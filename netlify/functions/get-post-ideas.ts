// netlify/functions/get-post-ideas.ts
// "Create Post" → Suggest an idea: returns the org's submitted post ideas with their lifecycle
// status so the user can track each one in the Review Queue → Ideas tab.
//
//   pending     → still sitting in the pool, not yet woven into a draft
//   in_review   → incorporated into a draft now awaiting review (links to that post)
//   delivered   → that draft was approved (links to the post)
//   discarded   → dropped
//
// GET /.netlify/functions/get-post-ideas[?assistantId=N]
//   Auth: aura_session cookie

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { and, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, postIdeaSuggestions, scheduledPosts, userOrganisations } from '../../db/schema';

const JWT_SECRET = process.env.JWT_SECRET;

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    try {
        const cookie = event.headers.cookie || '';
        const token = cookie.match(/aura_session=([^;]+)/)?.[1];
        if (!token || !JWT_SECRET) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };
        const session = jwt.verify(token, JWT_SECRET) as { userId: number };

        const db = getDb();

        const [membership] = await db
            .select({ organisationId: userOrganisations.organisationId })
            .from(userOrganisations)
            .where(eq(userOrganisations.userId, session.userId))
            .limit(1);
        if (!membership) return { statusCode: 403, body: JSON.stringify({ error: 'No organisation found.' }) };
        const organisationId = membership.organisationId;

        const assistantId = event.queryStringParameters?.assistantId
            ? Number(event.queryStringParameters.assistantId)
            : null;

        const where = assistantId
            ? and(eq(postIdeaSuggestions.organisationId, organisationId), eq(postIdeaSuggestions.assistantId, assistantId))
            : eq(postIdeaSuggestions.organisationId, organisationId);

        const ideas = await db
            .select({
                id: postIdeaSuggestions.id,
                idea: postIdeaSuggestions.idea,
                platform: postIdeaSuggestions.platform,
                status: postIdeaSuggestions.status,
                createdAt: postIdeaSuggestions.createdAt,
                usedAt: postIdeaSuggestions.usedAt,
                deliveredAt: postIdeaSuggestions.deliveredAt,
                usedPostId: postIdeaSuggestions.usedPostId,
                assistantName: aiAssistants.name,
                // Live state of the draft this idea produced (if any) — lets the UI link through and
                // show whether it's awaiting review, scheduled, published, etc.
                postStatus: scheduledPosts.status,
                postCaption: scheduledPosts.caption,
                postPlatform: scheduledPosts.platform,
                postPublishDate: scheduledPosts.publishDate,
            })
            .from(postIdeaSuggestions)
            .leftJoin(aiAssistants, eq(aiAssistants.id, postIdeaSuggestions.assistantId))
            .leftJoin(scheduledPosts, eq(scheduledPosts.id, postIdeaSuggestions.usedPostId))
            .where(where)
            // Surface still-open ideas (pending, then in_review) first, then resolved ones; newest first within each band.
            .orderBy(
                sql`CASE ${postIdeaSuggestions.status} WHEN 'pending' THEN 0 WHEN 'in_review' THEN 1 WHEN 'used' THEN 1 WHEN 'delivered' THEN 2 ELSE 3 END`,
                desc(postIdeaSuggestions.createdAt),
            )
            .limit(100);

        // Normalise the legacy 'used' label to 'in_review' for the client.
        const normalised = ideas.map(i => ({ ...i, status: i.status === 'used' ? 'in_review' : i.status }));

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ideas: normalised }),
        };
    } catch (err) {
        console.error('[get-post-ideas]', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal error.' }) };
    }
};
