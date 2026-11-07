// src/utils/site-draft-media-run.ts — finds or makes the media for a first draft
// (site-draft-media.ts has the rules). Reuses what the picture window uses: Pexels search and
// createPexelsAsset, generateAndPersistImage with a hold, startAiVideoJob and its worker. Each ends
// as a content_asset in the workspace's library.
//
// NEVER throws and never fails the draft: whatever can't be found, made or paid for is left out and
// said in the note. Stock is free. Each AI picture and clip is held and settled like any other, so
// failure costs nothing and a spot the allowance can't cover is skipped, not charged.

import { eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { mediaGenerationJobs } from '../../db/schema';
import { gatewayGenerate } from '../lib/ai-gateway';
import { generateAndPersistImage } from '../lib/media-persist';
import { holdCredits, IMAGE_CREDIT_COST, settleHold } from './ai-credits';
import { startAiVideoJob } from './ai-video-job';
import { gatewayRoleModel } from './assistant-model';
import { parseModelJson } from './model-json';
import { createPexelsAsset, searchUniqueImages, searchUniqueVideos, type PexelsCandidate, type PexelsVideoCandidate } from './pexels';
import { DRAFT_VIDEO_SECONDS } from './site-draft-media-options';
import {
    buildMediaPlanPrompt, cleanMediaPlan, DRAFT_MEDIA_CAPS, DRAFT_NOTE_READY,
    type DraftMediaChoice, type MediaPlacement, type MediaPlanBrief, type MediaSlot, type MediaSpot,
} from './site-draft-media';

type Db = ReturnType<typeof getDb>;

/** The whole media stage's share of the worker's time; site-store.ts also keeps it inside the 15-minute ceiling. */
export const DRAFT_MEDIA_BUDGET_MS = 8 * 60 * 1000;
/** The planning call gets this long; past it, the plan that needs no model is used. */
const PLAN_TIMEOUT_MS = 90_000;
const VIDEO_POLL_MS = 5_000;

/** The steps that reach outside, so a test can make each one fail. Each may throw; the run copes. */
export interface DraftMediaDeps {
    plan(): Promise<MediaSpot[]>;
    stock(kind: 'image' | 'video', query: string, exclude: string[]): Promise<{ assetId: number; providerAssetId: string } | null>;
    aiImage(scene: string): Promise<{ assetId: number } | 'no_tasks' | null>;
    startVideo(scene: string): Promise<{ jobId: number } | 'no_tasks' | null>;
    waitForVideo(jobId: number): Promise<{ assetId: number } | 'late' | null>;
    expired(): boolean;
}

export interface SourcedMedia { placements: MediaPlacement[]; note: string | null }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What was missed, in plain words. Null when everything chosen arrived. */
function noteFor(miss: { noTasks: number; failedImages: number; failedVideos: number; late: number }): string | null {
    const parts: string[] = [];
    if (miss.noTasks) parts.push(`Your tasks ran out, so ${plural(miss.noTasks, 'AI picture or video', 'AI pictures or videos')} weren't made and weren't charged.`);
    if (miss.failedImages) parts.push(`${plural(miss.failedImages, 'picture')} couldn't be found or made, and nothing was charged for ${miss.failedImages === 1 ? 'it' : 'them'}.`);
    if (miss.failedVideos) parts.push(`${plural(miss.failedVideos, 'video')} couldn't be found or made, and nothing was charged for ${miss.failedVideos === 1 ? 'it' : 'them'}.`);
    if (miss.late) parts.push('Your AI video is still being made. It will be in your library when it\'s done, and you can add it with Choose picture.');
    return parts.length ? `${DRAFT_NOTE_READY} ${parts.join(' ')}` : null;
}

/** The media for these sections, in this order: videos first, so the home page's top gets one if they chose it. */
export async function sourceDraftMedia(choice: DraftMediaChoice, slots: MediaSlot[], deps: DraftMediaDeps): Promise<SourcedMedia> {
    const miss = { noTasks: 0, failedImages: 0, failedVideos: 0, late: 0 };
    const placements: MediaPlacement[] = [];
    const attempt = async <T>(fn: () => Promise<T>): Promise<T | null> => {
        try { return await fn(); } catch (err) {
            console.error('[site-draft-media] a step failed; carrying on', err instanceof Error ? err.message : err);
            return null;
        }
    };
    const spots = (await attempt(() => deps.plan())) ?? [];
    const spotFor = new Map(spots.map((s) => [s.sectionId, s]));
    const usable = slots.map((s) => spotFor.get(s.sectionId)).filter((s): s is MediaSpot => !!s);

    const videoCap = choice.videos === 'stock' ? DRAFT_MEDIA_CAPS.stockVideos : choice.videos === 'ai' ? DRAFT_MEDIA_CAPS.aiVideos : 0;
    const imageCap = choice.images === 'stock' ? DRAFT_MEDIA_CAPS.stockImages : choice.images === 'ai' ? DRAFT_MEDIA_CAPS.aiImages : 0;
    const videoSpots = usable.slice(0, videoCap);
    const imageSpots = usable.slice(videoSpots.length, videoSpots.length + imageCap);
    const seenStock: Record<'image' | 'video', string[]> = { image: [], video: [] };

    const stock = async (kind: 'image' | 'video', spot: MediaSpot) => {
        const r = await attempt(() => deps.stock(kind, spot.query, seenStock[kind]));
        if (r) { seenStock[kind].push(r.providerAssetId); placements.push({ sectionId: spot.sectionId, assetId: r.assetId, alt: spot.alt }); }
        return !!r;
    };
    const aiImage = async (spot: MediaSpot) => {
        if (deps.expired()) return false;
        const r = await attempt(() => deps.aiImage(spot.scene));
        if (r === 'no_tasks') { miss.noTasks++; return true; }   // said once, as tasks, not as a failure
        if (r) { placements.push({ sectionId: spot.sectionId, assetId: r.assetId, alt: spot.alt }); return true; }
        return false;
    };
    const picture = async (spot: MediaSpot) => (choice.images === 'stock' ? stock('image', spot) : choice.images === 'ai' ? aiImage(spot) : false);

    // A video that doesn't arrive leaves its section to a picture, if they wanted pictures.
    const pictureInstead = async (spot: MediaSpot) => { if (choice.images !== 'none' && await picture(spot)) return; miss.failedVideos++; };

    // AI video takes minutes: started first, collected last.
    const jobs: Array<{ jobId: number; spot: MediaSpot }> = [];
    for (const spot of videoSpots) {
        if (choice.videos === 'stock') {
            if (!(await stock('video', spot))) await pictureInstead(spot);
        } else {
            const started = await attempt(() => deps.startVideo(spot.scene));
            if (started === 'no_tasks') { miss.noTasks++; if (choice.images !== 'none') await picture(spot); }
            else if (started) jobs.push({ jobId: started.jobId, spot });
            else await pictureInstead(spot);
        }
    }
    for (const spot of imageSpots) if (!(await picture(spot))) miss.failedImages++;
    for (const { jobId, spot } of jobs) {
        const r = await attempt(() => deps.waitForVideo(jobId));
        if (r === 'late') miss.late++;
        else if (r) placements.push({ sectionId: spot.sectionId, assetId: r.assetId, alt: spot.alt });
        else await pictureInstead(spot);
    }
    return { placements, note: noteFor(miss) };
}

/** The real steps, against Pexels, fal and the database. */
export function liveDraftMediaDeps(db: Db, ctx: {
    orgId: number; userId: number; assistantId: number; slots: MediaSlot[]; brief: MediaPlanBrief; deadlineAt: number;
}): DraftMediaDeps {
    const { orgId, userId, assistantId, slots, brief, deadlineAt } = ctx;
    return {
        expired: () => Date.now() >= deadlineAt,
        async plan() {
            const prompt = buildMediaPlanPrompt(brief, slots);
            const ask = (async () => {
                // The Website role's model, without its long thinking: this is a short list.
                const { model } = await gatewayRoleModel(db, 'website_assistant');
                const res = await gatewayGenerate({
                    system: prompt.system, messages: [{ role: 'user', content: prompt.user }], maxTokens: 1800,
                    usage: { workspaceId: orgId, assistantId }, model, deadlineMs: 60_000,
                });
                return parseModelJson(res.text);
            })();
            let timer: ReturnType<typeof setTimeout> | undefined;
            const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), PLAN_TIMEOUT_MS); });
            const raw = await Promise.race([ask.catch((err) => {
                console.error('[site-draft-media] planning failed; using the plain plan', err instanceof Error ? err.message : err);
                return null;
            }), timeout]);
            if (timer) clearTimeout(timer);
            return cleanMediaPlan(raw, slots, brief);
        },
        async stock(kind, query, exclude) {
            const opts = { keywords: query, dedup: false, exclude, limit: 3, orientation: 'landscape' as const };
            const candidates: Array<PexelsCandidate | PexelsVideoCandidate> = kind === 'video'
                ? (await searchUniqueVideos(db, orgId, query, opts)).candidates
                : (await searchUniqueImages(db, orgId, query, opts)).candidates;
            const c = candidates[0];
            if (!c) return null;
            const clean = { ...c, title: String(c.title || query).slice(0, 200), photographer: String(c.photographer || '').slice(0, 120), photographerUrl: String(c.photographerUrl || '').slice(0, 300) };
            const assetId = await createPexelsAsset(db, { userId, orgId, candidate: clean, assetType: kind });
            return { assetId, providerAssetId: c.providerAssetId };
        },
        async aiImage(scene) {
            const hold = await holdCredits(db, { orgId, amount: IMAGE_CREDIT_COST });
            if (!hold.ok) return 'no_tasks';
            try {
                const assetId = await generateAndPersistImage(db, { orgId, userId, prompt: scene, aspectRatio: '16:9' });
                await settleHold(db, { orgId, amount: IMAGE_CREDIT_COST, success: true, mediaType: 'image', userId, assistantId });
                return { assetId };
            } catch (err) {
                await settleHold(db, { orgId, amount: IMAGE_CREDIT_COST, success: false, mediaType: 'image', userId }).catch(() => {});
                throw err;
            }
        },
        async startVideo(scene) {
            const r = await startAiVideoJob(db, { orgId, userId, prompt: scene.slice(0, 1000), aspectRatio: '16:9', durationSeconds: DRAFT_VIDEO_SECONDS });
            if (r.ok) return { jobId: r.jobId };
            return r.reason === 'no_tasks' ? 'no_tasks' : null;
        },
        async waitForVideo(jobId) {
            for (;;) {
                const [job] = await db.select({ status: mediaGenerationJobs.status, ids: mediaGenerationJobs.resultAssetIds })
                    .from(mediaGenerationJobs).where(eq(mediaGenerationJobs.id, jobId)).limit(1);
                if (!job) return null;
                if (job.status === 'completed') {
                    const id = Array.isArray(job.ids) ? (job.ids as number[])[0] : null;
                    return id ? { assetId: id } : null;
                }
                if (job.status !== 'processing') return null;   // failed or flagged: the worker has refunded it
                if (Date.now() >= deadlineAt) return 'late';     // it carries on; the clip lands in their library
                await new Promise((r) => setTimeout(r, VIDEO_POLL_MS));
            }
        },
    };
}
