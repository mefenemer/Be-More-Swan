// src/utils/orchestration.ts
// Orchestration runtime (Phase 5) — fires cross-assistant hand-offs.
//
// When a SOURCE assistant fires a SOURCE_EVENT (drafts/publishes a post), each active
// orchestration_link hands off to its TARGET assistant by enqueuing a content_generation_job
// (the existing pipeline then produces a pending_approval draft in the target's queue). Every
// firing is logged to orchestration_runs (idempotent via UNIQUE(link_id, source_post_id)) and
// a notification is raised.
//
// A per-org, per-(UTC)-day cap bounds how many hand-offs an org can FIRE, as a cost/spam
// backstop (see HANDOFF_CAP_BY_TIER below). Over-cap firings are recorded as status='skipped'
// with no LLM call and no draft.
//
// Best-effort by contract: this NEVER throws to its caller — a hand-off failure must not break
// the draft/publish flow that triggered it. Callers should still `await` it inside their own
// try/catch or fire-and-forget wrapper.

import { randomUUID } from 'crypto';
import { and, count, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import {
    orchestrationLinks,
    orchestrationRuns,
    contentGenerationJobs,
    aiBlueprints,
    aiAssistants,
    notifications,
} from '../../db/schema';
import { createNotification } from './notify';
import { draftIssueFromPost } from './newsletter-from-post';
import { getActiveTierKeyByOrg } from './plan-features';

type Db = ReturnType<typeof getDb>;

export type OrchestrationEvent = 'drafts_a_post' | 'publishes_a_post' | 'completes_a_task';

// ── Per-org daily hand-off cap (cost guard) ───────────────────────────────────
// Each fired hand-off enqueues a real Claude generation job + a draft a human must review,
// so uncapped fan-out is a genuine cost/spam risk. We bound the number of hand-offs an org
// can FIRE per (UTC) day. The loop guard + UNIQUE(link_id, source_post_id) stop re-fires and
// dupes but not volume; this is the volume backstop (complementary to generate-post.ts's
// separate queued-jobs ceiling). Tier-scaled so higher plans get more head-room; unknown /
// no active plan falls back to DEFAULT.
const HANDOFF_CAP_BY_TIER: Record<string, number> = {
    buster:   25,
    saver:    50,
    employee: 100,
};
const DEFAULT_HANDOFF_CAP = 25;

/** UTC midnight for "now" — the per-day reset boundary. */
function startOfUtcDay(now = new Date()): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export interface FireOrchestrationsOpts {
    sourceAssistantId: number;
    orgId: number;
    userId: number;
    event: OrchestrationEvent;
    sourcePostId?: number | null;   // the post whose draft/publish triggered the hand-off
    sourceCaption?: string | null;  // grounds the target's generation
    /**
     * Which id space sourcePostId belongs to — 'blog_post' or 'social_post'. Only the blog path
     * sets it today, and only the newsletter branch below reads it: an issue drafted from a blog
     * post can be grounded in the post's actual words, where a social hand-off has a caption and
     * nothing else. Absent means "assume nothing and use the caption".
     */
    sourcePostKind?: 'blog_post' | 'social_post' | null;
}

/** ai_assistants.configuration.type for the Newsletter Assistant — see db/seed-catalog.ts. */
const NEWSLETTER_ROLE = 'newsletter_editor';

export async function fireOrchestrations(db: Db, opts: FireOrchestrationsOpts): Promise<void> {
    const {
        sourceAssistantId, orgId, userId, event,
        sourcePostId = null, sourceCaption = null, sourcePostKind = null,
    } = opts;
    try {
        // 1. Active links from this source for this event.
        const links = await db.select().from(orchestrationLinks).where(and(
            eq(orchestrationLinks.organisationId, orgId),
            eq(orchestrationLinks.sourceAssistantId, sourceAssistantId),
            eq(orchestrationLinks.sourceEvent, event),
            eq(orchestrationLinks.isActive, true),
        ));
        if (!links.length) return;

        // Resolve assistant names once (source + all targets) for the notification copy.
        const ids = Array.from(new Set([sourceAssistantId, ...links.map(l => l.targetAssistantId)]));
        const names = await db.select({
            id: aiAssistants.id,
            name: aiAssistants.name,
            // The TARGET'S ROLE DECIDES WHAT A HAND-OFF PRODUCES. Every other target here gets a
            // content_generation_job, which drafts a social post — the wrong artifact entirely for
            // a Newsletter Assistant, which produces newsletter_issues. The hub has always offered
            // every assistant as a target, so this link could already be built and quietly made a
            // social draft nobody would ever look for.
            roleType: sql<string | null>`${aiAssistants.configuration} ->> 'type'`,
        }).from(aiAssistants).where(inArray(aiAssistants.id, ids));
        const nameById = new Map(names.map(n => [n.id, n.name] as const));
        const roleById = new Map(names.map(n => [n.id, n.roleType] as const));
        const sourceName = nameById.get(sourceAssistantId) ?? 'An assistant';

        // 2. Resolve today's hand-off cap and how many we've already fired (UTC day). Runs we
        //    later mark 'skipped' don't count as fires, so the cap only bounds real hand-offs.
        const dayStart = startOfUtcDay();
        const tierKey = await getActiveTierKeyByOrg(db, orgId);
        const cap = HANDOFF_CAP_BY_TIER[tierKey ?? ''] ?? DEFAULT_HANDOFF_CAP;
        const [{ n: alreadyFired }] = await db.select({ n: count() })
            .from(orchestrationRuns)
            .where(and(
                eq(orchestrationRuns.organisationId, orgId),
                eq(orchestrationRuns.status, 'handed_off'),
                gte(orchestrationRuns.createdAt, dayStart),
            ));
        let firedToday = Number(alreadyFired) || 0;
        let limitNotified = false; // one "limit reached" notification per call at most

        for (const link of links) {
            const capped = firedToday >= cap;

            // 3. Idempotent claim: one run per (link, triggering post). A second firing for the
            //    same post (e.g. a retry) conflicts and returns [] → we skip it entirely. When
            //    capped we still claim the row (as 'skipped') — no LLM call, no draft.
            const [run] = await db.insert(orchestrationRuns).values({
                organisationId:    orgId,
                linkId:            link.id,
                sourceAssistantId,
                targetAssistantId: link.targetAssistantId,
                sourceEvent:       event,
                sourcePostId,
                status:            capped ? 'skipped' : 'handed_off',
            }).onConflictDoNothing().returning({ id: orchestrationRuns.id });
            if (!run) continue; // already fired for this post

            if (capped) {
                // Cost guard tripped: skip quietly (best-effort contract) and raise at most one
                // "daily limit reached" notification per org per day.
                if (!limitNotified) {
                    limitNotified = true;
                    try {
                        const [seen] = await db.select({ id: notifications.id })
                            .from(notifications)
                            .where(and(
                                eq(notifications.userId, userId),
                                eq(notifications.type, 'orchestration_limit_reached'),
                                gte(notifications.createdAt, dayStart),
                            ))
                            .limit(1);
                        if (!seen) {
                            await createNotification(db, 'orchestration_limit_reached', {
                                userId,
                                context: { handoff: { cap } },
                                metadata: { cap, tierKey, date: dayStart.toISOString().slice(0, 10) },
                            });
                        }
                    } catch { /* notification failure must not abort the remaining links */ }
                }
                continue;
            }

            firedToday++; // this hand-off counts toward the cap

            // 5a. A NEWSLETTER TARGET PRODUCES A NEWSLETTER ISSUE, not a content job. It needs no
            //     compiled blueprint (generateIssueBody builds its own brief from the org and the
            //     assistant), and the issue lands in 'pending_approval' — a hand-off must not be
            //     the one path that sends email without a person reading it first.
            let issueId: number | null = null;
            if (roleById.get(link.targetAssistantId) === NEWSLETTER_ROLE) {
                // ⚠️ ONLY ON A PUBLISH. An issue drafted when the post was merely DRAFTED would
                // point at a URL that does not exist yet — or carry no link at all, which is an
                // email about a post nobody can read. The API refuses to create such a link; this
                // is the runtime half of the same rule, for links built before it existed.
                // Falling through to the content-job path is not an option: that produces a social
                // post draft, which is the wrong artifact for this assistant entirely.
                if (event !== 'publishes_a_post') {
                    await db.update(orchestrationRuns)
                        .set({ status: 'skipped' })
                        .where(eq(orchestrationRuns.id, run.id));
                    firedToday--;
                    continue;
                }
                const drafted = await draftIssueFromPost(db, {
                    organisationId: orgId,
                    userId,
                    assistantId: link.targetAssistantId,
                    sourcePostId,
                    sourcePostKind,
                    sourceCaption,
                    targetAction: link.targetAction,
                });
                issueId = drafted.issueId;
                const targetName = nameById.get(link.targetAssistantId) ?? 'another assistant';
                // No issue means an expected no-op: this post already has one (a rebuilt link
                // firing for a post the previous link covered), the hand-off carried nothing to
                // write about, or the draft failed and cleaned up after itself. Record what
                // actually happened rather than logging a hand-off that produced nothing — "why is
                // there no issue for that post?" has to be answerable from this row. It also gives
                // the daily cap back, since no model call was made.
                if (!issueId) {
                    await db.update(orchestrationRuns)
                        .set({ status: 'skipped' })
                        .where(eq(orchestrationRuns.id, run.id));
                    firedToday--;
                    continue;
                }
                try {
                    await createNotification(db, 'orchestration_handoff', {
                        userId,
                        context: { handoff: { source_name: sourceName, target_name: targetName, target_action: link.targetAction } },
                        metadata: { linkId: link.id, runId: run.id, sourcePostId, newsletterIssueId: issueId },
                    });
                } catch { /* notification failure must not abort the remaining hand-offs */ }
                continue;
            }

            // 5b. Every other target: enqueue a draft (reuses the generation pipeline). Requires
            //     the target's compiled blueprint; if it has none yet, we still record the hand-off
            //     (run row + notification) but produce no draft.
            const [bp] = await db.select({ id: aiBlueprints.id })
                .from(aiBlueprints)
                .where(and(
                    eq(aiBlueprints.assistantId, link.targetAssistantId),
                    eq(aiBlueprints.organisationId, orgId),
                ))
                .orderBy(desc(aiBlueprints.compiledAt))
                .limit(1);

            let jobId: string | null = null;
            if (bp) {
                jobId = randomUUID();
                const snippet = (sourceCaption || '').trim().slice(0, 300);
                const contextPrompt = `${link.targetAction}. Context from ${sourceName}'s post${snippet ? `: "${snippet}"` : ''}.`.slice(0, 500);
                await db.insert(contentGenerationJobs).values({
                    jobId,
                    blueprintId:    bp.id,
                    assistantId:    link.targetAssistantId,
                    organisationId: orgId,
                    userId,
                    status:         'queued',
                    attempt:        0,
                    maxAttempts:    3,
                    contextPrompt,
                    triggerType:    'orchestration',   // loop guard: this draft won't re-fire orchestration
                });
                await db.update(orchestrationRuns).set({ targetJobId: jobId }).where(eq(orchestrationRuns.id, run.id));
            }

            // 6. Tell the user a hand-off happened (non-critical).
            const targetName = nameById.get(link.targetAssistantId) ?? 'another assistant';
            try {
                await createNotification(db, 'orchestration_handoff', {
                    userId,
                    context: { handoff: { source_name: sourceName, target_name: targetName, target_action: link.targetAction } },
                    metadata: { linkId: link.id, runId: run.id, sourcePostId, targetJobId: jobId },
                });
            } catch { /* notification failure must not abort the remaining hand-offs */ }
        }
    } catch (err) {
        // Never surface to the caller — a hand-off must not break the draft/publish flow.
        console.error('[fireOrchestrations] error', err);
    }
}
