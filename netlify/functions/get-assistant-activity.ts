// get-assistant-activity.ts
// GET ?id=<assistantId>&limit=<n>
// Returns a merged activity feed for the assistant detail page "Recent Activity" card.
// Pulls from content_generation_jobs, scheduled_posts, post_idea_suggestions,
// media_generation_jobs, relationship_building_tasks, audit_logs (both resourceType variants),
// tosAcceptances, dpaAcceptances, and contentRules (Kick Off meeting milestones).

import { Handler } from '@netlify/functions';
import { eq, and, desc, inArray, gte } from 'drizzle-orm';
import { getDb, withTenant } from '../../db/client';
import {
    aiAssistants,
    auditLogs,
    contentGenerationJobs,
    scheduledPosts,
    postIdeaSuggestions,
    mediaGenerationJobs,
    tosAcceptances,
    dpaAcceptances,
    contentRules,
} from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const assistantId = event.queryStringParameters?.id;
    if (!assistantId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'id parameter is required.' }) };
    }
    const aId = parseInt(assistantId);
    const limit = Math.min(parseInt(event.queryStringParameters?.limit ?? '50'), 100);

    const timeframe = event.queryStringParameters?.timeframe ?? '1d';
    const cutoffDate = (() => {
        const days = timeframe === '1d' ? 1 : timeframe === '7d' ? 7 : timeframe === '90d' ? 90 : timeframe === 'all' ? null : 30;
        if (days === null) return null;
        const d = new Date();
        d.setDate(d.getDate() - days);
        return d;
    })();

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId } = ctx;

    try {
        // IDOR guard — also capture userId so we can scope TOS acceptances to the assistant owner
        const ownedAssistant = await withTenant(orgId, async (tx) => {
            const [row] = await tx
                .select({
                    id: aiAssistants.id,
                    userId: aiAssistants.userId,
                })
                .from(aiAssistants)
                .where(and(eq(aiAssistants.id, aId), eq(aiAssistants.organisationId, orgId)))
                .limit(1);
            return row ?? null;
        });
        if (!ownedAssistant) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Assistant not found.' }) };
        }
        const assistantUserId = ownedAssistant.userId;

        const withCutoff = <T>(col: any, baseFilters: any) =>
            cutoffDate ? and(baseFilters, gte(col, cutoffDate)) : baseFilters;

        // Run all queries in parallel
        const [genJobs, posts, ideas, mediaJobs, auditRows, tosRows, dpaRows, ruleRows] = await Promise.all([
            // Content generation jobs
            db.select({
                id: contentGenerationJobs.id,
                status: contentGenerationJobs.status,
                platform: contentGenerationJobs.platform,
                triggerType: contentGenerationJobs.triggerType,
                contextPrompt: contentGenerationJobs.contextPrompt,
                createdAt: contentGenerationJobs.createdAt,
            })
            .from(contentGenerationJobs)
            .where(withCutoff(contentGenerationJobs.createdAt, and(
                eq(contentGenerationJobs.assistantId, aId),
                eq(contentGenerationJobs.organisationId, orgId),
            )))
            .orderBy(desc(contentGenerationJobs.createdAt))
            .limit(limit),

            // Scheduled posts
            db.select({
                id: scheduledPosts.id,
                status: scheduledPosts.status,
                platform: scheduledPosts.platform,
                publishDate: scheduledPosts.publishDate,
                publishedAt: scheduledPosts.publishedAt,
                postFormat: scheduledPosts.postFormat,
                isAutonomous: scheduledPosts.isAutonomous,
                createdAt: scheduledPosts.createdAt,
            })
            .from(scheduledPosts)
            .where(withCutoff(scheduledPosts.createdAt, and(
                eq(scheduledPosts.assistantId, aId),
                eq(scheduledPosts.organisationId, orgId),
            )))
            .orderBy(desc(scheduledPosts.createdAt))
            .limit(limit),

            // Post idea suggestions
            db.select({
                id: postIdeaSuggestions.id,
                idea: postIdeaSuggestions.idea,
                platform: postIdeaSuggestions.platform,
                status: postIdeaSuggestions.status,
                createdAt: postIdeaSuggestions.createdAt,
            })
            .from(postIdeaSuggestions)
            .where(withCutoff(postIdeaSuggestions.createdAt, and(
                eq(postIdeaSuggestions.assistantId, aId),
                eq(postIdeaSuggestions.organisationId, orgId),
            )))
            .orderBy(desc(postIdeaSuggestions.createdAt))
            .limit(limit),

            // Media generation jobs
            db.select({
                id: mediaGenerationJobs.id,
                mediaType: mediaGenerationJobs.mediaType,
                status: mediaGenerationJobs.status,
                prompt: mediaGenerationJobs.prompt,
                isAutonomous: mediaGenerationJobs.isAutonomous,
                createdAt: mediaGenerationJobs.createdAt,
            })
            .from(mediaGenerationJobs)
            .where(withCutoff(mediaGenerationJobs.createdAt, and(
                eq(mediaGenerationJobs.assistantId, aId),
                eq(mediaGenerationJobs.organisationId, orgId),
            )))
            .orderBy(desc(mediaGenerationJobs.createdAt))
            .limit(limit),

            // Audit log entries — covers both the legacy 'assistant' resourceType and
            // the 'ai_assistants' type written by transitionAssistantStatus (lifecycle events,
            // including the Kick Off ready_for_work → working transition).
            db.select({
                id: auditLogs.id,
                actionType: auditLogs.actionType,
                newState: auditLogs.newState,
                createdAt: auditLogs.createdAt,
            })
            .from(auditLogs)
            .where(withCutoff(auditLogs.createdAt, and(
                inArray(auditLogs.resourceType, ['assistant', 'ai_assistants']),
                eq(auditLogs.resourceId, String(assistantId)),
            )))
            .orderBy(desc(auditLogs.createdAt))
            .limit(limit),

            // ToS acceptances for the assistant owner (Kick Off milestone)
            assistantUserId
                ? db.select({
                    id: tosAcceptances.id,
                    version: tosAcceptances.version,
                    acceptedAt: tosAcceptances.acceptedAt,
                  })
                  .from(tosAcceptances)
                  .where(withCutoff(tosAcceptances.acceptedAt, eq(tosAcceptances.userId, assistantUserId)))
                  .orderBy(desc(tosAcceptances.acceptedAt))
                  .limit(5)
                : Promise.resolve([] as { id: number; version: string; acceptedAt: Date }[]),

            // DPA acceptances for this org (Kick Off milestone)
            db.select({
                id: dpaAcceptances.id,
                version: dpaAcceptances.version,
                email: dpaAcceptances.email,
                createdAt: dpaAcceptances.createdAt,
            })
            .from(dpaAcceptances)
            .where(withCutoff(dpaAcceptances.createdAt, eq(dpaAcceptances.organisationId, orgId)))
            .orderBy(desc(dpaAcceptances.createdAt))
            .limit(5),

            // Content rules (guardrails) added for this assistant (Kick Off milestone)
            db.select({
                id: contentRules.id,
                ruleText: contentRules.ruleText,
                category: contentRules.category,
                origin: contentRules.origin,
                createdAt: contentRules.createdAt,
            })
            .from(contentRules)
            .where(withCutoff(contentRules.createdAt, and(
                eq(contentRules.assistantId, aId),
                eq(contentRules.workspaceId, orgId),
                eq(contentRules.isActive, true),
            )))
            .orderBy(desc(contentRules.createdAt))
            .limit(limit),
        ]);

        // Map each source to a common shape { id, type, icon, description, createdAt }
        type ActivityStatus = 'success' | 'failed' | 'needs_input' | 'in_progress' | 'info';
        type ActivityItem = {
            id: string;
            type: string;
            icon: string;
            description: string;
            createdAt: Date;
            // Operational outcome for the unified Activity feed (Epic 2.2). Failed + needs_input
            // items are pinned into a "Needs attention" group on the assistant-detail Overview.
            status: ActivityStatus;
        };

        const items: ActivityItem[] = [];

        for (const j of genJobs) {
            const platformLabel = j.platform ? ` for ${_platformName(j.platform)}` : '';
            const contextHint = j.contextPrompt ? ` based on: "${j.contextPrompt.slice(0, 60)}${j.contextPrompt.length > 60 ? '…' : ''}"` : '';
            let description: string;
            let icon: string;
            let status: ActivityStatus;
            if (j.status === 'completed') {
                description = `Generated a post draft${platformLabel}${contextHint}.`;
                icon = 'sparkles';
                status = 'success';
            } else if (j.status === 'failed') {
                description = `Post generation attempt failed${platformLabel}.`;
                icon = 'alert';
                status = 'failed';
            } else if (j.status === 'processing') {
                description = `Writing a post${platformLabel}…`;
                icon = 'sparkles';
                status = 'in_progress';
            } else {
                description = `Queued a post for generation${platformLabel}.`;
                icon = 'sparkles';
                status = 'in_progress';
            }
            items.push({ id: `gen-${j.id}`, type: 'content_generation', icon, description, createdAt: j.createdAt, status });
        }

        for (const p of posts) {
            const platformLabel = _platformName(p.platform);
            const dateLabel = p.publishDate ? ` on ${new Date(p.publishDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : '';
            let description: string;
            let icon: string;
            let status: ActivityStatus;
            switch (p.status) {
                case 'published':
                    description = `Published a ${p.postFormat} post to ${platformLabel}${dateLabel}.`;
                    icon = 'check-circle';
                    status = 'success';
                    break;
                case 'scheduled':
                    description = `Scheduled a ${p.postFormat} post to ${platformLabel}${dateLabel}.`;
                    icon = 'calendar';
                    status = 'info';
                    break;
                case 'approved':
                    description = `Post for ${platformLabel} approved${dateLabel} — ready to publish.`;
                    icon = 'check';
                    status = 'success';
                    break;
                case 'pending_approval':
                case 'in_review':
                    description = `Post for ${platformLabel} sent for review${dateLabel}.`;
                    icon = 'clock';
                    status = 'needs_input';
                    break;
                case 'failed':
                    description = `Post publish to ${platformLabel} failed${dateLabel}.`;
                    icon = 'alert';
                    status = 'failed';
                    break;
                case 'cancelled':
                    description = `Scheduled ${platformLabel} post cancelled.`;
                    icon = 'x';
                    status = 'info';
                    break;
                default:
                    description = `${p.postFormat} draft created for ${platformLabel}${dateLabel}.`;
                    icon = 'edit';
                    status = 'info';
            }
            items.push({ id: `post-${p.id}`, type: 'scheduled_post', icon, description, createdAt: p.createdAt, status });
        }

        for (const idea of ideas) {
            const platformLabel = idea.platform ? ` for ${idea.platform.split(',').map(_platformName).join(', ')}` : '';
            const snippet = idea.idea ? ` — "${idea.idea.slice(0, 70)}${idea.idea.length > 70 ? '…' : ''}"` : '';
            let description: string;
            let status: ActivityStatus;
            switch (idea.status) {
                case 'delivered':
                    description = `Post idea delivered${platformLabel}${snippet}.`;
                    status = 'info';
                    break;
                case 'in_review':
                case 'used':
                    description = `Post idea woven into a draft${platformLabel}${snippet}.`;
                    status = 'success';
                    break;
                case 'discarded':
                    description = `Post idea discarded${platformLabel}.`;
                    status = 'info';
                    break;
                default:
                    // 'pending' is a normal waiting state — process-content-jobs.ts will pick it up
                    // FIFO and weave it into a future draft automatically. No user action is possible
                    // or required, so this must not be tagged 'needs_input' (there is nowhere to
                    // click through to and nothing to input).
                    description = `New post idea queued${platformLabel}${snippet} — it'll be woven into an upcoming draft automatically.`;
                    status = 'info';
            }
            items.push({ id: `idea-${idea.id}`, type: 'post_idea', icon: 'lightbulb', description, createdAt: idea.createdAt, status });
        }

        for (const m of mediaJobs) {
            const typeLabel = m.mediaType === 'video' ? 'video' : 'image';
            const promptSnippet = m.prompt ? ` — "${m.prompt.slice(0, 60)}${m.prompt.length > 60 ? '…' : ''}"` : '';
            let description: string;
            let icon: string;
            let status: ActivityStatus;
            if (m.status === 'completed') {
                description = `AI ${typeLabel} generated${promptSnippet}.`;
                icon = m.mediaType === 'video' ? 'video' : 'image';
                status = 'success';
            } else if (m.status === 'failed') {
                description = `AI ${typeLabel} generation failed.`;
                icon = 'alert';
                status = 'failed';
            } else {
                description = `Generating AI ${typeLabel}${promptSnippet}.`;
                icon = m.mediaType === 'video' ? 'video' : 'image';
                status = 'in_progress';
            }
            items.push({ id: `media-${m.id}`, type: 'media_generation', icon, description, createdAt: m.createdAt, status });
        }

        for (const log of auditRows) {
            const description = _describeAudit(log.actionType, log.newState as Record<string, any> | null);
            const icon = _auditIcon(log.actionType);
            items.push({ id: `audit-${log.id}`, type: 'audit', icon, description, createdAt: log.createdAt, status: 'info' });
        }

        // ── Kick Off meeting milestones ────────────────────────────────────────
        for (const t of tosRows) {
            items.push({
                id: `tos-${t.id}`,
                type: 'kickoff_milestone',
                icon: 'check-circle',
                description: `Terms of Service accepted (v${t.version}) — Kick Off meeting prerequisite met.`,
                createdAt: t.acceptedAt,
                status: 'info',
            });
        }

        for (const d of dpaRows) {
            items.push({
                id: `dpa-${d.id}`,
                type: 'kickoff_milestone',
                icon: 'check-circle',
                description: `Data Processing Agreement accepted (v${d.version})${d.email ? ` by ${d.email}` : ''} — Kick Off meeting prerequisite met.`,
                createdAt: d.createdAt,
                status: 'info',
            });
        }

        for (const r of ruleRows) {
            const catLabel = r.category ? ` (${r.category.replace(/_/g, ' ')})` : '';
            const snippet = r.ruleText ? `: "${r.ruleText.slice(0, 60)}${r.ruleText.length > 60 ? '…' : ''}"` : '';
            const origin = r.origin === 'rejection_feedback' ? ' from post feedback' : '';
            items.push({
                id: `rule-${r.id}`,
                type: 'guardrail',
                icon: 'shield',
                description: `Guardrail added${catLabel}${origin}${snippet}.`,
                createdAt: r.createdAt,
                status: 'info',
            });
        }

        // Sort all items newest-first, cap at limit
        items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        const paged = items.slice(0, limit);

        // Operational signal for the assistant-detail status pill (Epic 1): how many
        // content-generation jobs are mid-flight. Derived from the rows already fetched
        // above so the pill can read "Executing Task" without parsing translated strings.
        const activeJobCount = genJobs.filter(
            (j) => j.status === 'processing' || j.status === 'queued' || j.status === 'pending',
        ).length;

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ logs: paged, activeJobCount }),
        };

    } catch (err: any) {
        const msg: string = err?.message || '';
        if (msg.includes('relation') && msg.includes('does not exist')) {
            return { statusCode: 200, body: JSON.stringify({ logs: [] }) };
        }
        console.error('[get-assistant-activity]', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to load activity.' }) };
    }
};

function _platformName(p: string): string {
    const map: Record<string, string> = {
        instagram: 'Instagram',
        facebook: 'Facebook',
        linkedin: 'LinkedIn',
        x: 'X (Twitter)',
    };
    return map[p?.toLowerCase()] ?? p;
}

function _auditIcon(actionType: string): string {
    if (actionType.startsWith('assistant_lifecycle_')) return 'rocket';
    if (actionType === 'PLATFORM_CONNECTED' || actionType === 'INTEGRATION_ADDED') return 'link';
    if (actionType === 'PLATFORM_DISCONNECTED') return 'link';
    if (actionType === 'PUBLISH' || actionType === 'POST_SCHEDULED') return 'calendar';
    if (actionType === 'POST_APPROVED') return 'check';
    if (actionType === 'POST_CANCELLED') return 'x';
    return 'settings';
}

function _describeAudit(actionType: string, newState: Record<string, any> | null): string {
    const state = newState || {};
    // Lifecycle transitions written by transitionAssistantStatus
    if (actionType.startsWith('assistant_lifecycle_')) {
        const to = actionType.replace('assistant_lifecycle_', '');
        const from = (state.previousState as any)?.lifecycleStatus || '';
        const labels: Record<string, string> = {
            ready_for_work: 'ready for work',
            working: 'working',
            paused: 'paused',
            system_paused: 'system paused',
            archived: 'archived',
            provisioning: 'being set up',
        };
        if (to === 'working' && (from === 'ready_for_work' || state.reason === 'kick_off')) {
            return 'Kick Off meeting completed — assistant started working.';
        }
        if (to === 'ready_for_work') return 'Assistant set up and ready for Kick Off.';
        if (to === 'paused') return 'Assistant paused.';
        if (to === 'system_paused') return `Assistant automatically paused${state.reason ? ` (${state.reason})` : ''}.`;
        if (to === 'archived') return 'Assistant archived.';
        if (to === 'provisioning') return "Assistant setup started — we're getting it ready to work.";
        return `Assistant status changed to ${labels[to] ?? to}.`;
    }
    switch (actionType) {
        case 'CREATE':
            return `Assistant created${state.planName ? ` on the ${state.planName} plan` : ''}.`;
        case 'UPDATE':
            return _describeUpdate(state);
        case 'PUBLISH':
            return `Post published${state.platform ? ` to ${_platformName(state.platform)}` : ''}.`;
        case 'POST_SCHEDULED':
            return `Post scheduled${state.platform ? ` for ${_platformName(state.platform)}` : ''}${state.publishDate ? ` on ${new Date(state.publishDate).toLocaleDateString('en-GB')}` : ''}.`;
        case 'POST_APPROVED':
            return `Post approved${state.platform ? ` (${_platformName(state.platform)})` : ''}.`;
        case 'POST_CANCELLED':
            return 'Scheduled post cancelled.';
        case 'CONTEXT_UPDATED':
            return 'Assistant context and settings updated.';
        case 'PLATFORM_CONNECTED':
            return `Platform connected${state.platform ? `: ${_platformName(state.platform)}` : ''}.`;
        case 'PLATFORM_DISCONNECTED':
            return `Platform disconnected${state.platform ? `: ${_platformName(state.platform)}` : ''}.`;
        case 'INTEGRATION_ADDED':
            return `Integration added${state.name ? `: ${state.name}` : ''}.`;
        case 'AUTONOMOUS_ENABLED':
            return 'Autonomous posting fallback enabled.';
        case 'AUTONOMOUS_DISABLED':
            return 'Autonomous posting fallback disabled.';
        default:
            return actionType.replace(/_/g, ' ').toLowerCase().replace(/^\w/, c => c.toUpperCase()) + '.';
    }
}

function _describeUpdate(state: Record<string, any>): string {
    const changed = Object.keys(state).filter(k => k !== 'updatedAt' && k !== 'id');
    if (changed.length === 0) return 'Assistant settings updated.';
    if (changed.length === 1) {
        const key = changed[0].replace(/([A-Z])/g, ' $1').toLowerCase();
        return `Assistant ${key} updated.`;
    }
    return `Assistant updated (${changed.length} fields changed).`;
}
