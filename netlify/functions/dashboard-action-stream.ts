// netlify/functions/dashboard-action-stream.ts
// US-DASH-2: the dashboard "Action Stream" — one call that powers all three ACs.
//
//  GET → {
//    working:     [{ icon, assistantName, label, since }]        // AC1: currently processing
//    attention:   [{ kind:'post'|'action', id, ... verbs vary }] // AC2: needs approval
//    suggestions: [{ id, assistantId, assistantName, platform, idea }] // AC3: proactive ideas
//    counts: { working, attention, suggestions }
//  }
//
// Reuses the existing review/approval/idea pipelines (scheduled_posts pending_approval,
// pending_actions, post_idea_suggestions) rather than introducing a parallel one.
// Auth: aura_session cookie + active-org membership (requireTenant).

import { Handler } from '@netlify/functions';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import {
    aiAssistants,
    taskRuns,
    contentGenerationJobs,
    mediaGenerationJobs,
    scheduledPosts,
    pendingActions,
    postIdeaSuggestions,
    users,
} from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';

const _platformName = (p?: string | null): string => {
    if (!p) return '';
    const map: Record<string, string> = { instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn', x: 'X' };
    return map[p.toLowerCase()] ?? p;
};

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId, organisationId: orgId } = ctx;

    try {
        const [runningRuns, genJobs, mediaJobs, posts, actions, ideas] = await Promise.all([
            // AC1 — task runs actively executing or in quality review
            db.select({
                id: taskRuns.id,
                status: taskRuns.status,
                assistantName: aiAssistants.name,
                startedAt: taskRuns.startedAt,
                createdAt: taskRuns.createdAt,
            })
            .from(taskRuns)
            .leftJoin(aiAssistants, eq(aiAssistants.id, taskRuns.assistantId))
            .where(and(eq(taskRuns.organisationId, orgId), inArray(taskRuns.status, ['running', 'reviewing'])))
            .orderBy(desc(taskRuns.createdAt))
            .limit(6),

            // AC1 — posts being written right now
            db.select({
                id: contentGenerationJobs.id,
                platform: contentGenerationJobs.platform,
                assistantName: aiAssistants.name,
                createdAt: contentGenerationJobs.createdAt,
            })
            .from(contentGenerationJobs)
            .leftJoin(aiAssistants, eq(aiAssistants.id, contentGenerationJobs.assistantId))
            .where(and(eq(contentGenerationJobs.organisationId, orgId), eq(contentGenerationJobs.status, 'processing')))
            .orderBy(desc(contentGenerationJobs.createdAt))
            .limit(6),

            // AC1 — media being generated right now
            db.select({
                id: mediaGenerationJobs.id,
                mediaType: mediaGenerationJobs.mediaType,
                assistantName: aiAssistants.name,
                createdAt: mediaGenerationJobs.createdAt,
            })
            .from(mediaGenerationJobs)
            .leftJoin(aiAssistants, eq(aiAssistants.id, mediaGenerationJobs.assistantId))
            .where(and(eq(mediaGenerationJobs.organisationId, orgId), inArray(mediaGenerationJobs.status, ['processing', 'pending'])))
            .orderBy(desc(mediaGenerationJobs.createdAt))
            .limit(6),

            // AC2 — social drafts awaiting approval (reuses the Review Queue source of truth)
            db.select({
                id: scheduledPosts.id,
                platform: scheduledPosts.platform,
                postFormat: scheduledPosts.postFormat,
                caption: scheduledPosts.caption,
                generationReason: scheduledPosts.generationReason,
                isAutonomous: scheduledPosts.isAutonomous,
                publishDate: scheduledPosts.publishDate,
                assistantName: aiAssistants.name,
                createdAt: scheduledPosts.createdAt,
            })
            .from(scheduledPosts)
            .leftJoin(aiAssistants, eq(aiAssistants.id, scheduledPosts.assistantId))
            .where(and(eq(scheduledPosts.organisationId, orgId), eq(scheduledPosts.status, 'pending_approval')))
            .orderBy(desc(scheduledPosts.createdAt))
            .limit(8),

            // AC2 — HITL agentic actions awaiting the deployer's decision
            db.select({
                id: pendingActions.id,
                actionType: pendingActions.actionType,
                reversibilityTier: pendingActions.reversibilityTier,
                affectedRecordCount: pendingActions.affectedRecordCount,
                assistantName: aiAssistants.name,
                expiresAt: pendingActions.expiresAt,
                createdAt: pendingActions.createdAt,
            })
            .from(pendingActions)
            .leftJoin(aiAssistants, eq(aiAssistants.id, pendingActions.assistantId))
            .where(and(eq(pendingActions.userId, userId), eq(pendingActions.status, 'pending')))
            .orderBy(desc(pendingActions.createdAt))
            .limit(8),

            // AC3 — ideas a teammate suggested that are still in the pool (not yet woven into a draft).
            // These are always human-submitted (via "Suggest an idea" in Create Post), never
            // AI-generated, so the suggester's name must be surfaced rather than implying the
            // assistant came up with them itself.
            db.select({
                id: postIdeaSuggestions.id,
                idea: postIdeaSuggestions.idea,
                platform: postIdeaSuggestions.platform,
                assistantId: postIdeaSuggestions.assistantId,
                assistantName: aiAssistants.name,
                suggestedByFirstName: users.firstName,
                suggestedByLastName: users.lastName,
                suggestedByEmail: users.email,
                createdAt: postIdeaSuggestions.createdAt,
            })
            .from(postIdeaSuggestions)
            .leftJoin(aiAssistants, eq(aiAssistants.id, postIdeaSuggestions.assistantId))
            .leftJoin(users, eq(users.id, postIdeaSuggestions.userId))
            .where(and(eq(postIdeaSuggestions.organisationId, orgId), eq(postIdeaSuggestions.status, 'pending')))
            .orderBy(desc(postIdeaSuggestions.createdAt))
            .limit(6),
        ]);

        const working = [
            ...runningRuns.map(r => ({
                icon: r.status === 'reviewing' ? '🔍' : '⚙️',
                assistantName: r.assistantName || 'Your assistant',
                label: r.status === 'reviewing' ? 'Quality-checking its work' : 'Working on a task',
                since: r.startedAt || r.createdAt,
            })),
            ...genJobs.map(j => ({
                icon: '✍️',
                assistantName: j.assistantName || 'Your assistant',
                label: `Writing a ${_platformName(j.platform) || 'social'} post`,
                since: j.createdAt,
            })),
            ...mediaJobs.map(m => ({
                icon: m.mediaType === 'video' ? '🎬' : '🖼️',
                assistantName: m.assistantName || 'Your assistant',
                label: `Generating ${m.mediaType === 'video' ? 'a video' : 'an image'}`,
                since: m.createdAt,
            })),
        ];

        const attention = [
            ...posts.map(p => ({
                kind: 'post' as const,
                id: p.id,
                assistantName: p.assistantName || 'Your assistant',
                platform: _platformName(p.platform),
                title: `${p.isAutonomous ? 'Drafted' : 'Prepared'} a ${_platformName(p.platform) || 'social'} post for review`,
                preview: (p.caption || '').slice(0, 140),
                reason: p.generationReason || null,
                when: p.publishDate || null,
            })),
            ...actions.map(a => ({
                kind: 'action' as const,
                id: a.id,
                assistantName: a.assistantName || 'Your assistant',
                title: `Wants to ${(a.actionType || 'perform an action').replace(/_/g, ' ')}`,
                preview: a.affectedRecordCount ? `Affects ${a.affectedRecordCount} record${a.affectedRecordCount === 1 ? '' : 's'}` : '',
                reversibilityTier: a.reversibilityTier || null,
                expiresAt: a.expiresAt || null,
            })),
        ];

        const suggestions = ideas.map(i => ({
            id: i.id,
            assistantId: i.assistantId,
            assistantName: i.assistantName || 'Your assistant',
            suggestedByName: [i.suggestedByFirstName, i.suggestedByLastName].filter(Boolean).join(' ') || i.suggestedByEmail || 'A teammate',
            platform: i.platform || null,
            platformLabel: i.platform ? i.platform.split(',').map(_platformName).join(', ') : '',
            idea: i.idea || '',
        }));

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                working,
                attention,
                suggestions,
                counts: { working: working.length, attention: attention.length, suggestions: suggestions.length },
            }),
        };
    } catch (err: any) {
        const msg: string = err?.message || '';
        if (msg.includes('relation') && msg.includes('does not exist')) {
            return { statusCode: 200, body: JSON.stringify({ working: [], attention: [], suggestions: [], counts: { working: 0, attention: 0, suggestions: 0 } }) };
        }
        console.error('dashboard-action-stream error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to load action stream.' }) };
    }
};
