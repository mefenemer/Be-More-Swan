// src/utils/redraft-upcoming.ts
// "Redraft upcoming posts" (owner, 2026-11-02). A Social Media assistant drafts up to its draft horizon
// ahead (21 days for Love Cat Studio), so a change to its content pillars, core message or audience only
// reached posts drafted AFTER the change — three weeks later. To the owner, "What I post about" looked
// broken. This offers to redraft the upcoming drafts that nobody has approved yet, so the change shows now.
//
// How: the redraftable drafts are CANCELLED (the same thing "Request changes" does to the draft it
// replaces), and the schedule's own gap-fill (schedule-gap-fill.ts) re-queues those slots exactly as the
// daily drafting would — platforms, cross-posts, the weekly Short, and the pillars as they are NOW. No
// second drafting path.
//
// What is never touched — only what the assistant drafted on its own schedule and nobody has acted on:
//   · status other than pending_approval in ANY post of the slot (approved, scheduled, published…)
//   · a slot within MIN_LEAD_HOURS (it may be about to go out, or be under review right now)
//   · hand-written posts (no generation job), revisions answering the owner's feedback, campaign posts,
//     and a post drafted from a queued idea ("Suggest an idea" — the owner asked for that one)
//
// Cost: each redrafted slot is one drafting job, 1 task (work-metering.ts charges it when it lands).
// The preview states it; the apply refuses when the allowance can't cover it. GUI and chat both call
// netlify/functions/redraft-upcoming-posts.ts, which calls this.

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, scheduledPosts } from '../../db/schema';
import { enqueueScheduleGapFill } from './schedule-gap-fill';
import { getTaskUsage } from './work-metering';
import { TASK_WEIGHTS } from '../config/task-weights';
import { SMM_ROLE_KEYS } from '../constants/roles';

type Db = ReturnType<typeof getDb>;

/** A slot this close to going out is left alone. */
export const MIN_LEAD_HOURS = 2;

/** The set-up answers that decide what posts are ABOUT — a change to one is what the offer follows. */
export const TOPIC_SETUP_KEYS = ['content_pillars', 'core_message', 'target_audience', 'primary_objective', 'problem_statement', 'sales_objections'] as const;

export interface RedraftSlot { key: string; publishDate: string; postIds: number[] }
export interface RedraftPreview {
    ok: true;
    slots: number;
    tasks: number;
    first: string | null;
    last: string | null;
    /** Tasks left this month; null = no cap. */
    tasksLeft: number | null;
    /** Drafts left alone, and why — said on the card so nothing seems to have been missed. */
    kept: { approved: number; soon: number; handWritten: number };
}

interface Row {
    id: number; status: string; publishDate: Date; crosspostGroupId: string | null; jobId: string | null;
    isRevised: boolean; campaign: string | null; triggerType: string | null; claimedIdea: boolean;
}

/**
 * Pure: which slots may be redrafted. A slot = a crosspost group (or a lone post). Every post in it must
 * be redraftable, or the whole slot is kept.
 */
export function pickRedraftSlots(rows: Row[], now: Date): { slots: RedraftSlot[]; kept: RedraftPreview['kept'] } {
    const groups = new Map<string, Row[]>();
    for (const r of rows) {
        const key = r.crosspostGroupId || `post:${r.id}`;
        groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    const cutoff = now.getTime() + MIN_LEAD_HOURS * 3_600_000;
    const kept = { approved: 0, soon: 0, handWritten: 0 };
    const slots: RedraftSlot[] = [];
    for (const [key, posts] of groups) {
        if (posts.some((p) => p.status !== 'pending_approval')) { kept.approved++; continue; }
        if (posts.some((p) => new Date(p.publishDate).getTime() < cutoff)) { kept.soon++; continue; }
        if (posts.some((p) => !p.jobId || p.isRevised || p.campaign || p.triggerType !== 'scheduled' || p.claimedIdea)) { kept.handWritten++; continue; }
        const at = posts.map((p) => new Date(p.publishDate).getTime()).sort((a, b) => a - b)[0];
        slots.push({ key, publishDate: new Date(at).toISOString(), postIds: posts.map((p) => p.id) });
    }
    slots.sort((a, b) => a.publishDate.localeCompare(b.publishDate));
    return { slots, kept };
}

async function loadSocialAssistant(db: Db, orgId: number, assistantId: number) {
    const [a] = await db.select({
        id: aiAssistants.id, userId: aiAssistants.userId, organisationId: aiAssistants.organisationId, name: aiAssistants.name,
        onboardingContext: aiAssistants.onboardingContext, draftHorizonDays: aiAssistants.draftHorizonDays,
        configuration: aiAssistants.configuration, lifecycleStatus: aiAssistants.lifecycleStatus,
        roleKey: sql<string | null>`(${aiAssistants.configuration} ->> 'type')`,
    }).from(aiAssistants).where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, orgId))).limit(1);
    if (!a || !SMM_ROLE_KEYS.includes(String(a.roleKey))) return null;
    return a;
}

async function upcomingRows(db: Db, orgId: number, assistantId: number, now: Date): Promise<Row[]> {
    // Every post of the assistant's future slots still in the pipeline: a slot holding one approved
    // post must be SEEN to be kept, so the read isn't limited to pending_approval.
    const rows = await db.execute<{
        id: number; status: string; publish_date: Date; crosspost_group_id: string | null; job_id: string | null;
        is_revised: boolean; campaign: string | null; trigger_type: string | null; claimed_idea: boolean;
    }>(sql`
        SELECT p.id, p.status, p.publish_date, p.crosspost_group_id, p.job_id, p.is_revised, p.campaign, p.trigger_type,
               EXISTS (SELECT 1 FROM content_generation_jobs j
                        WHERE j.job_id = p.job_id AND coalesce(j.context_prompt, '') <> '') AS claimed_idea
          FROM scheduled_posts p
         WHERE p.organisation_id = ${orgId} AND p.assistant_id = ${assistantId}
           AND p.publish_date > ${now.toISOString()}
           AND p.status IN ('draft', 'pending_approval', 'in_review', 'approved', 'scheduled', 'publishing')`);
    return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
        id: Number(r.id), status: String(r.status), publishDate: new Date(r.publish_date as string), crosspostGroupId: (r.crosspost_group_id as string) ?? null,
        jobId: (r.job_id as string) ?? null, isRevised: !!r.is_revised, campaign: (r.campaign as string) ?? null,
        triggerType: (r.trigger_type as string) ?? null, claimedIdea: !!r.claimed_idea,
    }));
}

export async function previewRedraft(db: Db, orgId: number, assistantId: number, now = new Date()): Promise<RedraftPreview | { ok: false; status: number; error: string }> {
    const a = await loadSocialAssistant(db, orgId, assistantId);
    if (!a) return { ok: false, status: 404, error: 'Only a Social Media assistant\'s posts can be redrafted here.' };
    const { slots, kept } = pickRedraftSlots(await upcomingRows(db, orgId, assistantId, now), now);
    const usage = await getTaskUsage(db, orgId).catch(() => null);
    return {
        ok: true, slots: slots.length, tasks: slots.length * TASK_WEIGHTS.social_post,
        first: slots[0]?.publishDate ?? null, last: slots[slots.length - 1]?.publishDate ?? null,
        tasksLeft: usage && usage.hasPlan && usage.remaining !== null ? usage.remaining : null,
        kept,
    };
}

/**
 * Cancel the redraftable drafts and re-queue their slots. Refuses when the allowance can't cover them
 * (nothing is cancelled then). Returns how many slots were re-queued.
 */
export async function applyRedraft(db: Db, orgId: number, assistantId: number, now = new Date())
    : Promise<{ ok: true; cancelled: number; queued: number } | { ok: false; status: number; error: string }> {
    const a = await loadSocialAssistant(db, orgId, assistantId);
    if (!a) return { ok: false, status: 404, error: 'Only a Social Media assistant\'s posts can be redrafted here.' };
    if (a.lifecycleStatus !== 'working') return { ok: false, status: 409, error: `${a.name || 'This assistant'} is paused, so nothing would be redrafted. Resume it first.` };
    const { slots } = pickRedraftSlots(await upcomingRows(db, orgId, assistantId, now), now);
    if (!slots.length) return { ok: true, cancelled: 0, queued: 0 };
    const tasks = slots.length * TASK_WEIGHTS.social_post;
    const usage = await getTaskUsage(db, orgId).catch(() => null);
    if (usage && usage.hasPlan && usage.remaining !== null && usage.remaining < tasks) {
        return { ok: false, status: 402, error: `Redrafting ${slots.length} posts needs ${tasks} tasks, and ${usage.remaining} ${usage.remaining === 1 ? 'is' : 'are'} left this month. Nothing was changed.` };
    }
    const ids = slots.flatMap((s) => s.postIds);
    // Only still pending_approval: a post approved between the preview and this click is kept.
    const cancelled = await db.update(scheduledPosts)
        .set({ status: 'cancelled', cancelledAt: now, updatedAt: now })
        .where(and(eq(scheduledPosts.organisationId, orgId), inArray(scheduledPosts.id, ids), eq(scheduledPosts.status, 'pending_approval')))
        .returning({ id: scheduledPosts.id });
    const fill = await enqueueScheduleGapFill(db, {
        id: a.id, userId: a.userId, organisationId: a.organisationId, name: a.name, onboardingContext: a.onboardingContext,
        draftHorizonDays: a.draftHorizonDays, configuration: a.configuration,
    }, now);
    return { ok: true, cancelled: cancelled.length, queued: fill.enqueued };
}
