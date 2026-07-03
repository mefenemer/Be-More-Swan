// netlify/functions/reschedule-post-chat.ts
// Allow a user to ask their assistant to reschedule an individual post using natural language.
// The assistant parses the instruction (e.g. "next Friday at 3pm") into a concrete UTC timestamp
// and moves the post to that slot.  Any freed-up slot in the original cadence will be filled
// automatically by the daily gap-fill cron (draft-horizon-fill).
//
// POST /.netlify/functions/reschedule-post-chat
//   Auth: aura_session cookie
//   Body: { postId: number, instruction?: string, rescheduleAt?: string (ISO) }
//   — At least one of instruction or rescheduleAt is required.
//
// Returns:
//   200 { rescheduled: true, scheduledFor: ISO, confirmation: string }

import { Handler } from '@netlify/functions';
import { and, eq, ne, gte, lte, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, auditLogs, notifications, scheduledPosts } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { gatewayGenerate } from '../../src/lib/ai-gateway';

// Statuses that can be rescheduled (all non-terminal, non-publishing states).
const RESCHEDULABLE = ['draft', 'pending_approval', 'in_review', 'approved', 'scheduled'];

/**
 * Parse a natural-language scheduling instruction into a UTC Date.
 * Returns null if the LLM cannot determine a clear date/time.
 */
async function parseInstruction(instruction: string, now: Date, timezone: string): Promise<Date | null> {
    const localNow = now.toLocaleString('en-GB', {
        timeZone: timezone,
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
    });

    const { text } = await gatewayGenerate({
        system: `You are a scheduling assistant. Given a natural-language rescheduling instruction and the current date/time, output ONLY a valid ISO 8601 UTC timestamp (e.g. 2026-07-04T15:00:00Z) representing when the post should go out. If the instruction is ambiguous or you cannot determine a specific date/time, output exactly the word NULL. Output nothing else.`,
        messages: [{
            role: 'user',
            content: `Current date/time in user's timezone (${timezone}): ${localNow}\nInstruction: "${instruction}"\n\nISO UTC timestamp:`,
        }],
        maxTokens: 60,
    });

    const trimmed = text.trim();
    if (trimmed === 'NULL' || !trimmed) return null;

    // Accept ISO formats, strip any surrounding quotes or trailing text.
    const isoMatch = trimmed.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?(?:[+-]\d{2}:\d{2})?/);
    if (!isoMatch) return null;

    const parsed = new Date(isoMatch[0]);
    return isNaN(parsed.getTime()) ? null : parsed;
}

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId, organisationId } = ctx;

    let body: { postId?: number; instruction?: string; rescheduleAt?: string };
    try { body = JSON.parse(event.body || '{}'); } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) };
    }

    const postId = Number(body.postId);
    const instruction = (body.instruction || '').trim();
    const rescheduleAt = (body.rescheduleAt || '').trim();

    if (!postId) return { statusCode: 400, body: JSON.stringify({ error: 'postId is required.' }) };
    if (!instruction && !rescheduleAt) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Provide either a natural-language instruction or an explicit rescheduleAt timestamp.' }) };
    }
    if (instruction.length > 300) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Instruction must be 300 characters or fewer.' }) };
    }

    // Load the post and verify it belongs to the active org.
    const [post] = await db
        .select()
        .from(scheduledPosts)
        .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.organisationId, organisationId)))
        .limit(1);

    if (!post) return { statusCode: 404, body: JSON.stringify({ error: 'Post not found.' }) };

    if (!RESCHEDULABLE.includes(post.status)) {
        return {
            statusCode: 409,
            body: JSON.stringify({ error: `A post in '${post.status}' state cannot be rescheduled.` }),
        };
    }

    const now = new Date();
    let newPublishDate: Date;

    if (rescheduleAt) {
        // Explicit datetime from the picker — use directly.
        const parsed = new Date(rescheduleAt);
        if (isNaN(parsed.getTime())) {
            return { statusCode: 400, body: JSON.stringify({ error: 'rescheduleAt is not a valid date.' }) };
        }
        if (parsed <= now) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Scheduled time must be in the future.' }) };
        }
        newPublishDate = parsed;
    } else {
        // Natural-language path — resolve the assistant's timezone for correct parsing.
        let timezone = 'Europe/London';
        if (post.assistantId) {
            const [assistant] = await db
                .select({ onboardingContext: aiAssistants.onboardingContext })
                .from(aiAssistants)
                .where(eq(aiAssistants.id, post.assistantId))
                .limit(1);
            const tz = (assistant?.onboardingContext as Record<string, unknown>)?.timezone;
            if (typeof tz === 'string' && tz) timezone = tz;
        }

        let parsed: Date | null = null;
        try {
            parsed = await parseInstruction(instruction, now, timezone);
        } catch (err) {
            console.error('[reschedule-post-chat] LLM parse error', err);
            return { statusCode: 502, body: JSON.stringify({ error: 'The assistant could not reach the AI service. Please try again.' }) };
        }

        if (!parsed) {
            return {
                statusCode: 422,
                body: JSON.stringify({ error: "Your assistant couldn't work out a specific date and time from that. Try something like \"next Friday at 3pm\" or use the date picker." }),
            };
        }
        if (parsed <= now) {
            return {
                statusCode: 422,
                body: JSON.stringify({ error: `Your assistant understood that as ${parsed.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone })}, which is in the past. Please specify a future date.` }),
            };
        }
        newPublishDate = parsed;
    }

    // Check whether another post already occupies the target slot (same assistant, within ±15 min).
    let conflictWarning: string | null = null;
    if (post.assistantId) {
        const windowStart = new Date(newPublishDate.getTime() - 15 * 60_000);
        const windowEnd   = new Date(newPublishDate.getTime() + 15 * 60_000);
        const [conflict] = await db
            .select({ id: scheduledPosts.id })
            .from(scheduledPosts)
            .where(and(
                eq(scheduledPosts.assistantId, post.assistantId),
                ne(scheduledPosts.id, postId),
                gte(scheduledPosts.publishDate, windowStart),
                lte(scheduledPosts.publishDate, windowEnd),
                sql`status IN ('draft','pending_approval','in_review','approved','scheduled')`,
            ))
            .limit(1);
        if (conflict) {
            conflictWarning = 'Note: another post is already scheduled close to this time. Both will be queued.';
        }
    }

    // Persist the new schedule.  Move approved/scheduled posts back to 'scheduled' so they stay
    // in the queue; leave drafts/in_review as-is — they still need approval.
    const newStatus = ['approved', 'scheduled'].includes(post.status) ? 'scheduled' : post.status;

    await db
        .update(scheduledPosts)
        .set({ publishDate: newPublishDate, status: newStatus, updatedAt: now })
        .where(eq(scheduledPosts.id, postId));

    await db.insert(auditLogs).values({
        userId,
        actionType: 'POST_RESCHEDULED',
        resourceType: 'scheduled_posts',
        resourceId: String(postId),
        previousState: { publishDate: post.publishDate, status: post.status },
        newState: { publishDate: newPublishDate.toISOString(), status: newStatus, instruction: instruction || null },
    }).catch(() => {});

    const friendlyDate = newPublishDate.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
    const confirmation = instruction
        ? `Got it — your assistant has moved this post to ${friendlyDate}.${conflictWarning ? ' ' + conflictWarning : ''}`
        : `Post rescheduled to ${friendlyDate}.${conflictWarning ? ' ' + conflictWarning : ''}`;

    await db.insert(notifications).values({
        userId,
        type: 'post_rescheduled',
        title: 'Post rescheduled',
        message: confirmation,
        metadata: { postId, scheduledFor: newPublishDate.toISOString() },
    }).catch(() => {});

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            rescheduled: true,
            scheduledFor: newPublishDate.toISOString(),
            confirmation,
            conflictWarning,
        }),
    };
};
