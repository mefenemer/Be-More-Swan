// src/utils/video-autopilot.ts
// The Video Producer's autopilot (docs/video-producer-plan.md §5.9, owner decision D7: OFF by
// default; when on, 1–3 a week; always reviewed).
//
// What it does, and — the part that matters — what it does NOT:
//   · It writes STORYBOARDS. Planning is free (one model call, like any draft), so the weekly run
//     costs nothing. Making the video spends AI credits and stays the owner's click on "Make the
//     video" — the same rule as Brand Designer AI images and every chat card. An autopilot that
//     spent credits unattended is exactly the "cost surprise" §6 designed out.
//   · It never stacks up work nobody looked at: while MAX_WAITING autopilot storyboards are still
//     waiting for that click, it adds no more.
//   · It spreads the week: 1 a week waits 7 days between storyboards, 2 waits 3, 3 waits 2.
//   · It never invents a business from its name (autonomous-draft-brief.ts, prod org 43): no
//     Products & Services and no description means no storyboard. Topics rotate through the owner's
//     own products and services, least recently featured first.
//
// Run daily by netlify/functions/video-autopilot.ts. Pure helpers are exported for the tests.

import { and, eq, gte } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, masterAssistants, organisations, videoProjects } from '../../db/schema';
import { VIDEO_PRODUCER_ROLE_KEY } from '../constants/roles';
import { loadOrgProducts, type OrgProduct } from './org-products';
import { orgHasAssistantFeature } from './assistant-capabilities';
import { getActiveTierKeyByOrg } from './plan-features';
import { tierCanGenerateVideo } from './ai-credits';
import { capacityMemo } from './work-metering';
import { startProject } from './video-producer';
import { isWorking } from './video-handoff';

type Db = ReturnType<typeof getDb>;

/** The setup key (assistant-onboarding-schemas.js video_producer) — '0' (off) | '1' | '2' | '3'. */
export const AUTOPILOT_SETUP_KEY = 'autopilotPerWeek';
export const MAX_PER_WEEK = 3;
/** Autopilot storyboards that may wait for "Make the video" before the run adds another. */
export const MAX_WAITING = 2;

const DAY_MS = 24 * 60 * 60 * 1000;
/** A daily cron drifts by minutes; without slack "7 days later" would land on day 8. */
const SLACK_MS = 3 * 60 * 60 * 1000;

/** Videos a week the owner asked for. Anything unreadable is 0 — off, never a guess. Pure. */
export function autopilotPerWeek(onboardingContext: unknown): number {
    const ctx = (onboardingContext && typeof onboardingContext === 'object' ? onboardingContext : {}) as Record<string, unknown>;
    const n = Math.floor(Number(ctx[AUTOPILOT_SETUP_KEY]));
    return Number.isFinite(n) && n > 0 ? Math.min(MAX_PER_WEEK, n) : 0;
}

/** Days between two autopilot storyboards: 7 / 3 / 2. Pure. */
export function spacingDays(perWeek: number): number {
    return perWeek <= 1 ? 7 : Math.floor(7 / perWeek);
}

/**
 * Is a storyboard due now? `recent` = when this assistant's autopilot storyboards of the last 7 days
 * were created; `waiting` = how many of its autopilot storyboards still wait for "Make the video". Pure.
 */
export function autopilotDue(args: { perWeek: number; recent: Date[]; waiting: number; now: Date }): boolean {
    if (args.perWeek <= 0) return false;
    if (args.waiting >= MAX_WAITING) return false;
    const weekAgo = args.now.getTime() - 7 * DAY_MS + SLACK_MS;
    const thisWeek = args.recent.filter((d) => d.getTime() > weekAgo);
    if (thisWeek.length >= args.perWeek) return false;
    const last = Math.max(0, ...args.recent.map((d) => d.getTime()));
    return args.now.getTime() - last >= spacingDays(args.perWeek) * DAY_MS - SLACK_MS;
}

/**
 * What the next video is about. Rotates through the owner's products and services, least recently
 * featured first (a product counts as featured when an earlier brief names it); with none, a tip
 * from the business's own description. Null when there is nothing real to make a video from. Pure.
 */
export function pickAutopilotTopic(args: {
    products: OrgProduct[]; recentMessages: string[]; businessName: string | null; businessDescription: string | null;
}): { purpose: string; message: string } | null {
    const said = args.recentMessages.map((m) => m.toLowerCase());
    const usable = args.products.filter((p) => p.name && p.name.trim());
    if (usable.length) {
        const lastUse = (p: OrgProduct) => {
            const i = said.findIndex((m) => m.includes(p.name.trim().toLowerCase()));
            return i < 0 ? Infinity : i;   // recentMessages is newest first: a larger index is longer ago
        };
        const next = [...usable].sort((a, b) => lastUse(b) - lastUse(a))[0];
        const detail = [next.benefits, next.description].map((x) => (x ?? '').trim()).find(Boolean) ?? '';
        const kind = next.kind === 'service' ? 'service' : 'product';
        return {
            purpose: 'product spotlight',
            message: `Spotlight our ${kind} "${next.name.trim()}"${detail ? `: ${detail}` : ''}`.slice(0, 1200),
        };
    }
    const about = (args.businessDescription ?? '').trim();
    if (about.length < 40) return null;
    return {
        purpose: 'tip',
        message: `One useful tip for our customers, drawn from what we do. About the business: ${about}`.slice(0, 1200),
    };
}

export interface AutopilotRunResult {
    checked: number; planned: number; off: number; notDue: number; noTopic: number; notOnPlan: number; overTaskLimit: number;
}

/** One pass over every active Video Producer. Exported so staging can drive it in-process. */
export async function runVideoAutopilot(db: Db, now: Date = new Date()): Promise<AutopilotRunResult> {
    const producers = await db.select({
        id: aiAssistants.id, organisationId: aiAssistants.organisationId, onboardingContext: aiAssistants.onboardingContext,
        lifecycleStatus: aiAssistants.lifecycleStatus, provisioningStatus: aiAssistants.provisioningStatus,
    })
        .from(aiAssistants)
        .innerJoin(masterAssistants, eq(aiAssistants.masterAssistantId, masterAssistants.id))
        .where(and(eq(aiAssistants.isActive, true), eq(masterAssistants.roleKey, VIDEO_PRODUCER_ROLE_KEY)));

    const result: AutopilotRunResult = { checked: producers.length, planned: 0, off: 0, notDue: 0, noTopic: 0, notOnPlan: 0, overTaskLimit: 0 };
    const hasCapacity = capacityMemo(db);

    for (const a of producers) {
        try {
            const perWeek = autopilotPerWeek(a.onboardingContext);
            // Off, or paused: a paused assistant does no work (owner, 2026-10-24).
            if (!perWeek || !isWorking(a.lifecycleStatus, a.provisioningStatus)) { result.off++; continue; }

            const since = new Date(now.getTime() - 30 * DAY_MS);
            const mine = await db.select({ createdAt: videoProjects.createdAt, status: videoProjects.status, origin: videoProjects.origin, brief: videoProjects.brief })
                .from(videoProjects)
                .where(and(eq(videoProjects.organisationId, a.organisationId), eq(videoProjects.aiAssistantId, a.id), gte(videoProjects.createdAt, since)));
            const auto = mine.filter((p) => p.origin === 'autopilot');
            const waiting = auto.filter((p) => p.status === 'planned' || p.status === 'planning').length;
            if (!autopilotDue({ perWeek, recent: auto.map((p) => p.createdAt), waiting, now })) { result.notDue++; continue; }

            // The same gate as the Videos tab (video-projects.ts): a plan with video, and a hire that can make it.
            if (!tierCanGenerateVideo(await getActiveTierKeyByOrg(db, a.organisationId))
                || !await orgHasAssistantFeature(db, a.organisationId, 'ai_video_generation')) { result.notOnPlan++; continue; }
            if (!(await hasCapacity(a.organisationId))) { result.overTaskLimit++; continue; }

            const [[org], products] = await Promise.all([
                db.select({ name: organisations.name, description: organisations.businessDescription })
                    .from(organisations).where(eq(organisations.id, a.organisationId)).limit(1),
                loadOrgProducts(db, a.organisationId),
            ]);
            const recentMessages = [...mine]
                .sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime())
                .map((p) => String((p.brief as { message?: unknown })?.message ?? ''));
            const topic = pickAutopilotTopic({ products, recentMessages, businessName: org?.name ?? null, businessDescription: org?.description ?? null });
            if (!topic) { result.noTopic++; continue; }

            const started = await startProject(db, {
                organisationId: a.organisationId, assistantId: a.id, createdBy: null,
                brief: topic, onboardingContext: a.onboardingContext, origin: 'autopilot',
            });
            if (started.ok) result.planned++;
        } catch (err) {
            console.error(`[video-autopilot] assistant ${a.id} failed`, err);
        }
    }
    return result;
}
