// src/utils/video-producer.ts
//
// The Video Producer's two background steps (docs/video-producer-plan.md §5.3–5.8):
//
//   planProject  — brief → storyboard. The model writes it; src/lib/storyboard.ts enforces the rules.
//                  Free (one model call, like any draft). The owner reviews the storyboard next.
//   buildProject — storyboard → a finished post. One voiceover for the whole script (its word timings
//                  set each scene's length), each scene sourced from what the storyboard named, then
//                  ONE scheduled_posts row per platform (a cross-post group) carrying a video_edit,
//                  the voiceover with captions on, and the on-screen text as timed overlays.
//
// The finished video is deliberately an ORDINARY post: it lands in the Review Queue, renders on approve
// through the existing Remotion path, and publishes through the existing drivers. Nothing downstream
// knows a Video Producer made it.
//
// Money: the build's AI spend (AI images, AI clips, the voiceover) is estimated and HELD before anything
// is made, settled item by item as each one succeeds, and the remainder refunded at the end — a build
// that fails at scene 4 keeps (and has paid for) scenes 1–3, which a re-build reuses (scene_assets).
// Stock, library pictures and brand cards are free.
//
// ⚠️ Still scenes need a Remotion bundle from 2026-10-31 or later — redeploy both sites first.

import { randomUUID } from 'crypto';
import { and, desc, eq, inArray, isNull, lt, notInArray, or } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { contentAssets, organisations, scheduledPostAssets, scheduledPosts, videoProjects } from '../../db/schema';
import { gatewayGenerate } from '../lib/ai-gateway';
import { gatewayRoleModel } from './assistant-model';
import { loadAssistantRulesBlock } from './assistant-rules-prompt';
import { loadOrgProducts, renderProductFacts } from './org-products';
import { normalizeBrandKit } from './brand-kit';
import { holdCredits, settleHold, IMAGE_CREDIT_COST, VIDEO_CREDIT_COST, VOICEOVER_CREDIT_COST, type MediaKind } from './ai-credits';
import { TASK_WEIGHTS, aiVideoTasks } from '../config/task-weights';
import { createPexelsAsset, searchUniqueImages, searchUniqueVideos, type PexelsVideoCandidate } from './pexels';
import { generateAndPersistImage, persistBufferToR2, persistRemoteMediaToR2, r2IsConfigured, renderAndPersistBrandCard } from '../lib/media-persist';
import { submitFramedVideo, status as falStatus, result as falResult, cancel as falCancel, extractVideo, falConfigured, imageToVideoEnabled, takesAnyLength, billedSecondsFor, i2vModel } from '../lib/fal-gateway';
import { logMediaCost } from './ai-usage';
import { makeVoiceoverAsset } from './voiceover-asset';
import { DEFAULT_VOICE, isVoiceId, cleanScript, languageLabel, voiceLanguage } from '../lib/tts';
import { normalizeCaptionStyle } from '../lib/captions';
import { presignR2Get } from './social-publish';
import { resolveBaseUrl } from './base-url';
import { isUnifiedTaskMetering } from './task-metering-flag';
import {
    enforceStoryboard, estimateCredits, parseStoryboardJson, sceneTimingsFromWords, scriptOf, isStillSource, WORDS_PER_SECOND,
    storyboardSystemPrompt, storyboardUserPrompt, isVideoLength,
    type LibraryPicture, type Scene, type Storyboard, type VideoBrief,
} from '../lib/storyboard';
import type { VideoClip, VideoEdit } from '../lib/video-edit';
import type { AudioOverlay } from '../lib/audio-overlays';
import { PAD_RATIO, type Overlay } from '../lib/overlay-geometry';
import { recordPlatformIncident } from './platform-incident';
import { asOwnVideos, footageStatus, loadFootage, ownVideos } from './footage-review';
import { describeTightening, footagePlannerBlock, ownSpeechOnTimeline, silentWav, suggestionLine, tightenStoryboard, MAX_VIDEOS_PER_REVIEW, type FootageReview, type SpokenWord as FootageWord } from '../lib/footage';
import { keepsOwnSound, minScenesFor } from '../lib/storyboard';

type Db = ReturnType<typeof getDb>;

/** The platforms a Video Producer video can go to today, and the vertical format on each. */
export const VIDEO_DESTINATIONS: Record<string, string> = { instagram: 'ig_reel', youtube: 'yt_short', facebook: 'fb_reel' };

/**
 * One attempt at an AI clip. Kling 3's slowest bake-off clip took 4 m 25 s (2026-11-01); a staging
 * build that day had one job report IN_PROGRESS for 9 minutes and never finish. An attempt past this
 * is cancelled at Fal and tried once more from the same first frame. Two attempts plus the
 * voiceover stay inside the 15-minute background-function ceiling, because stock scenes are made
 * while the AI clips generate (buildProject).
 */
export const AI_CLIP_ATTEMPT_MS = 6 * 60 * 1000;
export const AI_CLIP_ATTEMPTS = 2;
const AI_CLIP_POLL_MS = 5000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const BUILD_COSTS = { image: IMAGE_CREDIT_COST, video: VIDEO_CREDIT_COST, voiceover: VOICEOVER_CREDIT_COST };

/**
 * Fill what a brief leaves out from the assistant's setup answers (defaultVoice, defaultLength,
 * defaultAllowAi, defaultCta — assistant-onboarding-schemas.js video_producer). The brief always
 * wins; setup only fills gaps. Pure.
 */
export function withSetupDefaults(raw: unknown, onboardingContext: unknown): Record<string, unknown> {
    const b = { ...((raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>) };
    const setup = (onboardingContext && typeof onboardingContext === 'object' ? onboardingContext : {}) as Record<string, unknown>;
    const has = (k: string) => b[k] != null && b[k] !== '';
    if (!has('voice') && b.voiceover !== false && isVoiceId(setup.defaultVoice)) b.voice = setup.defaultVoice;
    if (!has('lengthS') && isVideoLength(setup.defaultLength)) b.lengthS = Number(setup.defaultLength);
    if (!has('allowAi') && typeof setup.defaultAllowAi === 'string') b.allowAi = setup.defaultAllowAi;
    if (!has('cta') && typeof setup.defaultCta === 'string' && setup.defaultCta.trim()) b.cta = setup.defaultCta;
    if (!has('language') && typeof setup.defaultLanguage === 'string' && setup.defaultLanguage) b.language = setup.defaultLanguage;
    if (b.captions == null && (setup.defaultCaptions === 'off' || setup.defaultCaptions === false)) b.captions = false;
    if (!has('captionStyle') && setup.captionStyle) {
        // Saved by the setup screens as JSON text (a hidden input), or as an object.
        let style: unknown = setup.captionStyle;
        if (typeof style === 'string') { try { style = JSON.parse(style); } catch { style = null; } }
        if (style && typeof style === 'object') b.captionStyle = style;
    }
    return b;
}

/** Normalise a brief from a request body. Pure; returns an error string when unusable. */
export function readBrief(raw: unknown): { brief: VideoBrief & { platforms: string[] } } | { error: string } {
    const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const message = String(b.message ?? '').trim();
    if (message.length < 10) return { error: 'Say what the video should be about (a sentence or two).' };
    const lengthS = isVideoLength(b.lengthS) ? Number(b.lengthS) as VideoBrief['lengthS'] : 30;
    const allowAi = b.allowAi === 'stock_only' || b.allowAi === 'ai_first' ? b.allowAi : 'stock_and_ai';
    const platforms = (Array.isArray(b.platforms) ? b.platforms : ['instagram'])
        .map((p) => String(p).toLowerCase()).filter((p) => p in VIDEO_DESTINATIONS);
    const footage = readFootageIds(b.footageAssetIds);
    return {
        brief: {
            purpose: String(b.purpose ?? 'promo').slice(0, 60),
            lengthS,
            message: message.slice(0, 1200),
            cta: typeof b.cta === 'string' && b.cta.trim() ? b.cta.trim().slice(0, 200) : null,
            voiceover: b.voiceover !== false,
            voice: isVoiceId(b.voice) ? b.voice : DEFAULT_VOICE,
            allowAi,
            musicMood: typeof b.musicMood === 'string' ? b.musicMood.slice(0, 40) : null,
            language: languageLabel(b.language) ? String(b.language) : null,
            captions: b.captions !== false,
            captionStyle: b.captionStyle && typeof b.captionStyle === 'object' ? normalizeCaptionStyle(b.captionStyle) : null,
            platforms: platforms.length ? [...new Set(platforms)] : ['instagram'],
            ...(footage.length ? { footageAssetIds: footage, tighten: b.tighten !== false } : {}),
        },
    };
}

/** The owner's chosen videos from a brief: positive integers, unique, at most MAX_VIDEOS_PER_REVIEW. Pure. */
export function readFootageIds(raw: unknown): number[] {
    if (!Array.isArray(raw)) return [];
    return [...new Set(raw.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, MAX_VIDEOS_PER_REVIEW);
}

// ── Start ───────────────────────────────────────────────────────────────────────────────────────

/** Where a video came from (video_projects.origin, db/z-video-producer-phase7.sql). */
export type VideoOrigin = 'user' | 'autopilot' | 'handoff' | 'campaign';
/** The same words as the Videos tab (assistant-videos.js ORIGIN). 'user' says nothing — the owner asked. */
const ORIGIN_LABELS: Record<string, string> = { autopilot: 'planned by autopilot', handoff: 'from one of their posts', campaign: 'for a campaign' };

/**
 * Wake the background worker. MUST be awaited — Lambda freezes on return (see generate-ai-video).
 * Headers are optional: a cron or a campaign order has none, and resolveBaseUrl falls back to the
 * deploy's own URL. A wake that never arrives leaves the project 'planning' until the stuck sweep
 * fails it (20 min) — never spent, never silent.
 */
export async function wakeVideoWorker(payload: Record<string, unknown>, headers?: Record<string, string | undefined>): Promise<boolean> {
    const baseUrl = resolveBaseUrl(headers);
    if (!baseUrl) { console.error('[video-producer] no base URL — worker not woken', payload); return false; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
        await fetch(`${baseUrl}/.netlify/functions/process-video-project-background`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal,
        });
        return true;
    } catch (err) {
        console.error('[video-producer] could not wake the worker:', err);
        return false;
    } finally { clearTimeout(timer); }
}

/**
 * Create a project and start planning it — the ONE way a video begins, whoever asked: the Videos
 * tab and chat cards ('user'), the weekly autopilot, "Make a video version" on a post ('handoff'),
 * or a Campaign Assistant order. What the brief leaves out comes from the assistant's setup.
 * Planning is free; nothing here spends. Returns the row, or why the brief is unusable.
 */
export async function startProject(db: Db, args: {
    organisationId: number; assistantId: number; createdBy: number | null; brief: unknown; onboardingContext: unknown;
    origin: VideoOrigin; sourcePostId?: number | null; campaignId?: number | null; campaignOrderId?: number | null;
    headers?: Record<string, string | undefined>;
}): Promise<{ ok: true; row: typeof videoProjects.$inferSelect } | { ok: false; error: string }> {
    const parsed = readBrief(withSetupDefaults(args.brief, args.onboardingContext));
    if ('error' in parsed) return { ok: false, error: parsed.error };
    // The owner's own footage is reviewed first (src/utils/footage-review.ts); the storyboard follows
    // their ticks. Everything else is planned straight away.
    const footage = !!parsed.brief.footageAssetIds?.length;
    const [row] = await db.insert(videoProjects).values({
        organisationId: args.organisationId, aiAssistantId: args.assistantId, createdBy: args.createdBy,
        title: parsed.brief.message.slice(0, 60), status: footage ? 'reviewing' : 'planning', brief: parsed.brief,
        origin: args.origin, sourcePostId: args.sourcePostId ?? null,
        campaignId: args.campaignId ?? null, campaignOrderId: args.campaignOrderId ?? null,
    }).returning();
    await wakeVideoWorker({ projectId: row.id, action: footage ? 'review' : 'plan' }, args.headers);
    return { ok: true, row };
}

/** The workspace's own pictures the planner may use as product photos — newest first. */
export async function libraryPictures(db: Db, orgId: number, limit = 30): Promise<LibraryPicture[]> {
    const rows = await db.select({ id: contentAssets.id, name: contentAssets.name })
        .from(contentAssets)
        // Stock and AI pictures are not "the business's own"; uploads and brand cards are.
        .where(and(
            eq(contentAssets.organisationId, orgId), eq(contentAssets.assetType, 'image'), isNull(contentAssets.purgedAt),
            or(isNull(contentAssets.provider), notInArray(contentAssets.provider, ['pexels', 'fal'])),
        ))
        .orderBy(desc(contentAssets.createdAt))
        .limit(limit);
    return rows.map((r) => ({ id: r.id, name: r.name || `Picture ${r.id}` }));
}

// ── Plan ────────────────────────────────────────────────────────────────────────────────────────

export async function planProject(db: Db, projectId: number, opts: { feedback?: string | null } = {}): Promise<void> {
    const [p] = await db.select().from(videoProjects).where(eq(videoProjects.id, projectId)).limit(1);
    if (!p || p.status !== 'planning') return;
    const brief = p.brief as VideoBrief;
    try {
        const [[org], products, library, footage] = await Promise.all([
            db.select({ name: organisations.name, description: organisations.businessDescription, industry: organisations.industry })
                .from(organisations).where(eq(organisations.id, p.organisationId)).limit(1),
            loadOrgProducts(db, p.organisationId),
            libraryPictures(db, p.organisationId),
            loadFootage(db, p.organisationId, brief.footageAssetIds ?? []),
        ]);
        // A footage video: the owner's ticks decide which suggested edits the plan must apply.
        const review = p.footageReview as FootageReview | null;
        const acceptedEdits = review?.suggestions.filter((x) => x.ticked).map(suggestionLine) ?? [];
        const declinedEdits = review?.suggestions.filter((x) => !x.ticked).map(suggestionLine) ?? [];
        const own = asOwnVideos(footage);
        const facts = [org?.industry ? `Industry: ${org.industry}` : '', org?.description ?? '', renderProductFacts(products, 2500)]
            .filter(Boolean).join('\n');
        const rules = p.aiAssistantId
            ? await loadAssistantRulesBlock(db, { assistantId: p.aiAssistantId, organisationId: p.organisationId })
            : null;
        const model = await gatewayRoleModel(db, 'video_producer');
        const ask = async (feedback: string | null | undefined) => {
            const res = await gatewayGenerate({
                system: storyboardSystemPrompt() + (rules ? `\n\n${rules}` : ''),
                messages: [{ role: 'user', content: storyboardUserPrompt({
                    brief, businessName: org?.name ?? '', businessFacts: facts, library,
                    today: new Date().toISOString().slice(0, 10), feedback,
                    language: languageLabel(brief.language ?? (brief.voiceover ? voiceLanguage(brief.voice ?? DEFAULT_VOICE) : 'en')),
                    footageBlock: footagePlannerBlock(footage), acceptedEdits, declinedEdits,
                }) }],
                maxTokens: 2500,
                deadlineMs: 120_000,
                usage: { workspaceId: p.organisationId, assistantId: p.aiAssistantId ?? null },
                ...model,
            });
            return enforceStoryboard(parseStoryboardJson(res.text), brief, library, own);
        };
        let { storyboard, changes } = await ask(opts.feedback);
        // The voiceover sets the video's length, so a long script makes a long video: a "30-second"
        // sample came out at 45 s and outran the render Lambdas (2026-11-01). Over budget by more than
        // a fifth → plan once more, told how many words to lose. Still free; never a third attempt.
        const over = scriptOverBudget(storyboard, brief);
        if (over) {
            const again = await ask([opts.feedback, `The voiceover is ${over.words} words; a ${brief.lengthS}-second video has room for about ${over.budget}. Cut it to ${over.budget} words or fewer — shorter lines, not fewer facts that matter.`].filter(Boolean).join(' '));
            if (again.storyboard.scenes.length >= minScenesFor(brief) && (scriptOverBudget(again.storyboard, brief)?.words ?? 0) < over.words) ({ storyboard, changes } = again);
        }
        if (storyboard.scenes.length < minScenesFor(brief)) throw new Error('The plan came back too short to make a video from. Try again, or add more detail to the brief.');
        // Footage in its own sound: pauses, "um"s and repeated takes out, from the review's words.
        if (footage.length) {
            const t = tightenStoryboard(storyboard, brief, footage);
            storyboard = t.storyboard;
            changes = [...changes, ...t.changes];
        }
        await db.update(videoProjects).set({
            status: 'planned', storyboard, changes, title: storyboard.title, note: null, updatedAt: new Date(),
        }).where(eq(videoProjects.id, projectId));
    } catch (err) {
        console.error(`[video-producer] plan ${projectId} failed:`, err);
        const [owner] = await db.select({ orgId: videoProjects.organisationId, assistantId: videoProjects.aiAssistantId }).from(videoProjects).where(eq(videoProjects.id, projectId)).limit(1).catch(() => []);
        if (owner) await recordPlatformIncident(db, { kind: 'video_plan', error: err, organisationId: owner.orgId, assistantId: owner.assistantId, role: 'video_producer', view: 'video-producer', ids: { projectId } });
        await db.update(videoProjects).set({
            status: 'failed', note: err instanceof Error ? err.message.slice(0, 400) : 'The storyboard could not be written.', updatedAt: new Date(),
        }).where(eq(videoProjects.id, projectId));
    }
}

/**
 * Is the script too long for the brief's length? The budget is WORDS_PER_SECOND × length (the rate
 * the prompt asks for); more than 20% over returns the count and the budget, otherwise null. Pure.
 */
export function scriptOverBudget(storyboard: Storyboard, brief: VideoBrief): { words: number; budget: number } | null {
    if (!brief.voiceover) return null;
    const words = scriptOf(storyboard).split(/\s+/).filter(Boolean).length;
    const budget = Math.round(brief.lengthS * WORDS_PER_SECOND);
    return words > budget * 1.2 ? { words, budget } : null;
}

// ── Build ───────────────────────────────────────────────────────────────────────────────────────

/** Tasks a build holds under the single task allowance — the same weights the ledger records. Pure. */
export function buildTasks(storyboard: Storyboard, brief: VideoBrief): number {
    let n = 0;
    for (const s of storyboard.scenes) {
        if (s.source === 'ai_image') n += TASK_WEIGHTS.ai_image;
        if (s.source === 'ai_video') n += aiVideoTasks(billedSecondsFor(aiClipSeconds(s.targetS)));
    }
    if (brief.voiceover && scriptOf(storyboard)) n += TASK_WEIGHTS.ai_voiceover;
    return n;
}

/**
 * The on-screen text size, as a fraction of the frame HEIGHT, so its longest line fits a 9:16 frame.
 * The box keeps line breaks and never wraps by itself (overlay-geometry.ts whiteSpace: 'pre'), and at
 * a fixed 5% "Yellow flame? Get it checked" ran off both edges in the first sample render
 * (2026-11-01). Anton (the Impact stand-in) is about 0.5 of its height wide per character, plus the
 * box padding either side; the line may use ~90% of a width that is 9/16 of the height. Never larger
 * than 5%, never smaller than 2.8%. Pure.
 */
export function onScreenFontPct(text: string): number {
    const n = Math.max(1, ...text.trim().split('\n').map((l) => l.trim().length));
    // Rounded DOWN: rounding to nearest could tip a line that just fits over the edge.
    return Math.floor(Math.max(0.028, Math.min(0.05, (0.9 * 9 / 16) / (0.5 * n + 2 * PAD_RATIO))) * 1000) / 1000;
}

/** Past this many characters one line gets too small to read on a phone, so it becomes two. */
export const ONE_LINE_MAX = 28;

/**
 * Long on-screen text as two balanced lines, broken at the space nearest the middle. A long line hit
 * the 2.8% floor and still ran off both edges (Harbour Yoga sample, 2026-11-02, owner: "some of the
 * text overlay is off the screen"). Pure.
 */
export function onScreenLines(text: string): string {
    const t = text.trim().replace(/\s+/g, ' ');
    if (t.length <= ONE_LINE_MAX) return t;
    const mid = t.length / 2;
    let best = -1;
    for (let i = 0; i < t.length; i++) if (t[i] === ' ' && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
    return best < 0 ? t : `${t.slice(0, best)}\n${t.slice(best + 1)}`;
}

/** The text overlays for a storyboard, timed to the scenes. Pure. */

/**
 * How a branded card is drawn inside a video. Centred, because a video card is an end screen seen
 * full-frame, not a feed post; and the dark ('bold') polarity, because the captions are white — on a
 * light card the spoken words vanished (Harbour Yoga sample, 2026-11-02, owner: "text at the end is
 * off the screen"; "Pop in this week text is not centred").
 */
export const VIDEO_CARD = {
    variant: 'bold' as const,
    layout: {
        headline: { show: true, align: 'center' as const, y: 0.42, x: null },
        wordmark: { show: true, align: 'center' as const, y: 0, x: null },
        website: { show: true, align: 'center' as const, y: 1, x: null },
    },
};

export function sceneOverlays(scenes: Scene[], durations: number[], captionPosition: 'bottom' | 'middle' | 'top' = 'bottom'): Overlay[] {
    const out: Overlay[] = [];
    let t = 0;
    scenes.forEach((s, i) => {
        const d = durations[i] ?? s.targetS;
        // A branded card already carries these words as its headline (sourceScene 'brand_card') —
        // overlaid as well, the first sample render showed "Pop in this week" three times at once
        // (card, overlay, captions). The card says it; the overlay stays off.
        if (s.onScreenText && s.source !== 'brand_card') {
            const text = onScreenLines(s.onScreenText);
            out.push({
                id: `vp_${s.id}`, text,
                // Upper third: the captions own the lower part of the frame — unless they were moved
                // to the top, when the on-screen text takes the lower part instead.
                x: 0.5, y: captionPosition === 'top' ? 0.7 : 0.2, fontFamily: 'Impact', fontSizePct: onScreenFontPct(text),
                color: '#FFFFFF', boxStroke: null, boxFill: '#000000', boxOpacity: 0.55,
                startS: Math.round(t * 10) / 10, endS: Math.round((t + d) * 10) / 10, anim: 'rise',
            });
        }
        t += d;
    });
    return out;
}

/**
 * How long an AI clip to ask for. `targetS` is the scene's SPOKEN length here, and the clip must
 * cover it with the same 0.3 s margin stock gets: the render clamps a short clip, which pulls every
 * later scene ahead of its voiceover. A 6.4 s line got a 6 s request under the old "over 7 → 10"
 * rule (plumbing sample, 2026-11-01) — and Kling v2.x makes 5 or 10 s, so a "6" was really 5.
 * Kling v3 makes any whole length 3–15 s, so it gets exactly what the line needs, no more.
 */
export function aiClipSeconds(targetS: number, model: string = i2vModel()): number {
    const need = targetS + 0.3;
    if (!imageToVideoEnabled(model)) return need > 6 ? 10 : 6;   // Hailuo text-to-video: 6 or 10
    if (takesAnyLength(model)) return Math.min(15, Math.max(3, Math.ceil(need)));
    return need > 5 ? 10 : 5;
}

/**
 * Where an own-video scene plays in its source: from its cut, for `d` seconds. Under a voiceover the
 * voice sets `d`, which can outrun the cut — the window then runs on past the cut, or starts earlier,
 * but never past the end of the file (that fails the whole render). A file shorter than `d` plays
 * whole and the scene is shorter. Pure.
 */
export function ownWindow(inS: number, d: number, fileS: number): { inS: number; outS: number } {
    const len = Math.min(d, fileS);
    const start = Math.max(0, Math.min(inS, fileS - len));
    return { inS: Math.round(start * 100) / 100, outS: Math.round(Math.min(fileS, start + len) * 100) / 100 };
}

/**
 * The timeline for a storyboard whose scenes have assets. Pure.
 *
 * `own` says how the owner's footage plays: each video's measured length (`fileS`) and whether the
 * video keeps the footage's sound. Own clips get an explicit gain — full in their own sound, silent
 * under a voiceover — and stock clips are silenced in a video that keeps its own sound, because the
 * render mutes clips only while some other track exists.
 */
export function sceneClips(scenes: Scene[], assetIds: Record<string, number>, durations: number[], own?: { fileS: Map<number, number>; ownSound: boolean }): VideoClip[] {
    return scenes.flatMap((s, i): VideoClip[] => {
        const assetId = assetIds[s.id];
        if (!assetId) return [];
        const d = durations[i] ?? s.targetS;
        if (isStillSource(s.source)) {
            return [{ id: `vp_${s.id}`, assetId, kind: 'image' as const, holdS: d, ...(s.motion && s.motion !== 'none' ? { motion: s.motion } : {}) }];
        }
        if (s.source === 'own_video') {
            const fileS = own?.fileS.get(assetId) ?? (s.outS ?? d);
            // Tightened (own sound only): one clip per piece of the same file, back to back.
            if (own?.ownSound && s.cuts?.length) {
                return livePieces(s.cuts, fileS).map((p, k) => ({ id: `vp_${s.id}_${k + 1}`, assetId, inS: p.inS, outS: p.outS, gain: 1 }));
            }
            const w = ownWindow(s.inS ?? 0, d, fileS);
            return [{ id: `vp_${s.id}`, assetId, inS: w.inS, outS: w.outS, gain: own?.ownSound ? 1 : 0 }];
        }
        return [{ id: `vp_${s.id}`, assetId, inS: 0, outS: d, ...(own?.ownSound ? { gain: 0 } : {}) }];
    });
}

/** A tightened scene's pieces that lie inside the file (re-checked at build: never past the end). Pure. */
export function livePieces(cuts: Array<{ inS: number; outS: number }>, fileS: number): Array<{ inS: number; outS: number }> {
    return cuts
        .map((p) => ({ inS: Math.max(0, Math.min(fileS, p.inS)), outS: Math.max(0, Math.min(fileS, p.outS)) }))
        .filter((p) => p.outS - p.inS >= 0.1);
}

/**
 * How long each scene actually plays once own clips are fitted to their files. A tightened scene
 * (own sound) plays exactly its pieces. Pure.
 */
export function playedDurations(scenes: Scene[], durations: number[], fileS: Map<number, number>, ownSound = false): number[] {
    return scenes.map((s, i) => {
        const d = durations[i] ?? s.targetS;
        if (s.source !== 'own_video' || !s.assetId) return d;
        const f = fileS.get(s.assetId);
        if (ownSound && s.cuts?.length) {
            const len = livePieces(s.cuts, f ?? Infinity).reduce((a, p) => a + (p.outS - p.inS), 0);
            return Math.round(len * 100) / 100;
        }
        return f ? Math.min(d, f) : d;
    });
}

async function sourceScene(db: Db, args: {
    scene: Scene; orgId: number; userId: number; assistantId: number | null; brandName: string; exclude: string[];
    kit: ReturnType<typeof normalizeBrandKit>; seed: number;
}): Promise<{ assetId: number; mediaKind?: MediaKind; cost?: number; tasks?: number; asStill?: boolean } | null> {
    const { scene, orgId, userId } = args;
    const context = scene.keywords || scene.prompt || scene.voiceover;
    switch (scene.source) {
        case 'product_photo':
            return scene.assetId ? { assetId: scene.assetId } : null;
        case 'own_video': {
            // Checked again here: the storyboard was enforced at plan time, but the video could have
            // been deleted since. Only the workspace's own upload, never someone else's asset id.
            if (!scene.assetId) return null;
            const [a] = await db.select({ id: contentAssets.id }).from(contentAssets)
                .where(and(eq(contentAssets.id, scene.assetId), eq(contentAssets.organisationId, orgId), eq(contentAssets.assetType, 'video'), isNull(contentAssets.purgedAt), isNull(contentAssets.provider)))
                .limit(1);
            return a ? { assetId: a.id } : null;
        }
        case 'stock_video': {
            // Portrait first: the video is 9:16, and a centre-cropped landscape clip cuts people's heads
            // off. Any shape only when portrait finds nothing — a cropped clip beats an empty scene.
            //
            // Long enough, too: a clip shorter than its scene made Remotion ask for a frame past its end
            // ("No frame found at position…") and the WHOLE render failed (sample videos, 2026-11-01).
            // Only a clip whose Pexels duration covers the scene (+0.3 s) is used; with none, the scene
            // becomes a moving stock photo, which can be held for any length.
            const need = scene.targetS + 0.3;
            const longEnough = (cs: PexelsVideoCandidate[]) => cs.find((x) => (x.duration ?? 0) >= need);
            const opts = { limit: 8, keywords: scene.keywords, exclude: args.exclude };
            const c = longEnough((await searchUniqueVideos(db, orgId, context, { ...opts, orientation: 'portrait' })).candidates)
                ?? longEnough((await searchUniqueVideos(db, orgId, context, opts)).candidates);
            if (c) {
                args.exclude.push(c.providerAssetId);
                return { assetId: await createPexelsAsset(db, { userId, orgId, candidate: c, assetType: 'video' }) };
            }
            const photo = await sourceScene(db, { ...args, scene: { ...scene, source: 'stock_photo' } });
            return photo ? { ...photo, asStill: true } : null;
        }
        case 'stock_photo': {
            const opts = { limit: 3, keywords: scene.keywords, exclude: args.exclude };
            const r = await searchUniqueImages(db, orgId, context, { ...opts, orientation: 'portrait' });
            const c = r.candidates[0] ?? (await searchUniqueImages(db, orgId, context, opts)).candidates[0];
            if (!c) return null;
            args.exclude.push(c.providerAssetId);
            return { assetId: await createPexelsAsset(db, { userId, orgId, candidate: c, assetType: 'image' }) };
        }
        case 'brand_card': {
            const headline = scene.onScreenText || scene.voiceover.split(/[.!?]/)[0] || args.brandName;
            return { assetId: await renderAndPersistBrandCard(db, { orgId, userId, headline: headline.slice(0, 80), kit: args.kit, aspectRatio: '9:16', orgName: args.brandName, ...VIDEO_CARD }) };
        }
        case 'ai_image':
            return {
                assetId: await generateAndPersistImage(db, { orgId, userId, prompt: scene.prompt || context, aspectRatio: '9:16' }),
                mediaKind: 'image', cost: IMAGE_CREDIT_COST,
            };
        case 'ai_video': {
            if (!falConfigured()) return null;
            let frameUrl: string | null = null;
            let sub: Awaited<ReturnType<typeof submitFramedVideo>> | null = null;
            for (let attempt = 1; attempt <= AI_CLIP_ATTEMPTS && !sub; attempt++) {
                const tried = await submitFramedVideo({
                    prompt: `${scene.prompt || context}. Slow, steady camera movement; one continuous shot.`,
                    imagePrompt: scene.prompt || context, startImageUrl: frameUrl, aspectRatio: '9:16',
                    durationSeconds: aiClipSeconds(scene.targetS),
                    usage: { workspaceId: orgId, userId, assistantId: args.assistantId },
                });
                frameUrl ??= tried.frameUrl;   // a retry animates the same picture, not a new one
                const deadline = Date.now() + AI_CLIP_ATTEMPT_MS;
                let finished = false;
                while (Date.now() < deadline) {
                    if ((await falStatus(tried.statusUrl)) === 'COMPLETED') { finished = true; break; }
                    await sleep(AI_CLIP_POLL_MS);
                }
                if (finished) sub = tried;
                else {
                    await falCancel(tried.statusUrl);
                    console.warn(`[video-producer] AI clip attempt ${attempt} timed out and was cancelled (${tried.model})`);
                }
            }
            if (!sub) throw new Error('An AI clip took too long and was abandoned.');
            const v = extractVideo(await falResult(sub.responseUrl));
            logMediaCost(sub.model, { durationSeconds: sub.billedSeconds }, { workspaceId: orgId, userId, assistantId: args.assistantId, sessionId: 'fal-video' });
            const stored = await persistRemoteMediaToR2({ orgId, url: v.url, contentType: v.contentType || 'video/mp4', folder: 'video-producer', label: 'AI scene' });
            const [asset] = await db.insert(contentAssets).values({
                userId, organisationId: orgId, name: `AI scene — ${(scene.prompt || context).slice(0, 60)}`,
                assetType: 'video', mimeType: 'video/mp4', fileSize: stored.fileSize, storageKey: stored.storageKey,
                durationS: sub.billedSeconds, provider: 'fal', prompt: scene.prompt || context, aspectRatio: '9:16', status: 'pending',
            }).returning({ id: contentAssets.id });
            return { assetId: asset.id, mediaKind: 'video', cost: VIDEO_CREDIT_COST, tasks: aiVideoTasks(sub.billedSeconds) };
        }
    }
    return null;
}

/**
 * A caption-only track: a silent WAV with the spoken words on it as a voiceover's word timings
 * (render_params.kind 'voiceover'), which is where the render reads captions from (post-render.ts).
 * Free — no AI is called; the words came from the footage review.
 */
async function makeCaptionTrack(db: Db, args: { orgId: number; userId: number; words: FootageWord[]; name: string }): Promise<number> {
    const end = args.words[args.words.length - 1]?.end ?? 1;
    const stored = await persistBufferToR2({ orgId: args.orgId, bytes: silentWav(1), contentType: 'audio/wav', folder: 'video-producer' });
    const script = args.words.map((w) => w.word).join(' ');
    const [asset] = await db.insert(contentAssets).values({
        userId: args.userId, organisationId: args.orgId, name: args.name,
        assetType: 'audio', mimeType: 'audio/wav', fileSize: stored.fileSize, storageKey: stored.storageKey,
        durationS: end, renderParams: { kind: 'voiceover', captionOnly: true, script, words: args.words }, status: 'pending',
    }).returning({ id: contentAssets.id });
    return asset.id;
}

export async function buildProject(db: Db, projectId: number): Promise<void> {
    const [p] = await db.select().from(videoProjects).where(eq(videoProjects.id, projectId)).limit(1);
    if (!p || p.status !== 'building' || !p.storyboard) return;
    const orgId = p.organisationId;
    const userId = p.createdBy;
    const brief = p.brief as VideoBrief & { platforms?: string[] };
    const storyboard = p.storyboard as Storyboard;
    let held = p.creditHold;
    let spent = p.creditsSpent;
    const done: Record<string, number> = { ...(p.sceneAssets as Record<string, number>) };

    const settle = async (mediaType: MediaKind, cost: number, success: boolean, tasks?: number) => {
        await settleHold(db, { orgId, amount: cost, success, mediaType, userId, assistantId: p.aiAssistantId ?? null, tasks });
        held = Math.max(0, held - cost);
        if (success) spent += cost;
    };
    const save = (patch: Partial<typeof videoProjects.$inferInsert>) =>
        db.update(videoProjects).set({ ...patch, creditHold: held, creditsSpent: spent, sceneAssets: done, updatedAt: new Date() })
            .where(eq(videoProjects.id, projectId));

    try {
        if (userId == null) throw new Error('The person who started this video no longer has an account.');
        if (!r2IsConfigured()) throw new Error('Storage is not configured, so the video cannot be made.');
        const [org] = await db.select({ name: organisations.name, brandKit: organisations.brandKit })
            .from(organisations).where(eq(organisations.id, orgId)).limit(1);
        const kit = normalizeBrandKit(org?.brandKit);

        // 1. The voiceover — it decides how long every scene is.
        let voiceoverAssetId = p.voiceoverAssetId ?? null;
        let words: Array<{ start: number; end: number }> = [];
        const script = cleanScript(scriptOf(storyboard));
        if (brief.voiceover && script) {
            if (voiceoverAssetId) {
                const [a] = await db.select({ renderParams: contentAssets.renderParams }).from(contentAssets)
                    .where(and(eq(contentAssets.id, voiceoverAssetId), eq(contentAssets.organisationId, orgId))).limit(1);
                words = ((a?.renderParams as { words?: Array<{ start: number; end: number }> } | null)?.words) ?? [];
            } else {
                try {
                    const vo = await makeVoiceoverAsset(db, {
                        orgId, userId, assistantId: p.aiAssistantId ?? null, script,
                        voice: isVoiceId(brief.voice) ? brief.voice : DEFAULT_VOICE,
                        name: `Voiceover · ${storyboard.title}`.slice(0, 80),
                    });
                    voiceoverAssetId = vo.assetId;
                    words = vo.words;
                    await settle('voiceover', VOICEOVER_CREDIT_COST, true);
                } catch (err) {
                    await settle('voiceover', VOICEOVER_CREDIT_COST, false);
                    throw new Error(`The voiceover could not be made (${err instanceof Error ? err.message : 'unknown error'}).`);
                }
            }
            await save({ voiceoverAssetId });
        }
        // The owner's footage: each video's measured length, and its spoken words for captions.
        const footage = await loadFootage(db, orgId, brief.footageAssetIds ?? []);
        const fileS = new Map(footage.filter((v) => v.durationS > 0).map((v) => [v.id, v.durationS]));
        const ownSound = keepsOwnSound(brief);
        // Own clips can't play past their file, so a scene is never longer than its video.
        const durations = playedDurations(storyboard.scenes, sceneTimingsFromWords(storyboard, words) ?? storyboard.scenes.map((s) => s.targetS), fileS, ownSound);

        // 2. Every scene's picture or clip. Already-made scenes are kept (a re-build after a failure).
        // AI clips all at once: each spends minutes at the model (Kling 3 averaged 3 m 48 s in the
        // 2026-11-01 bake-off), and made one after another, three of them plus the voiceover ran into
        // this worker's 15-minute ceiling. The other scenes go one by one alongside them — stock
        // scenes share `exclude`, so the same clip isn't picked twice.
        const exclude: string[] = [];
        const failed = new Set<number>();
        const makeScene = async (i: number) => {
            const scene = storyboard.scenes[i];
            let made: Awaited<ReturnType<typeof sourceScene>> = null;
            const paid = scene.source === 'ai_image' ? IMAGE_CREDIT_COST : scene.source === 'ai_video' ? VIDEO_CREDIT_COST : 0;
            try {
                made = await sourceScene(db, { scene: { ...scene, targetS: durations[i] }, orgId, userId, assistantId: p.aiAssistantId ?? null, brandName: org?.name ?? '', exclude, kit, seed: projectId * 10 + i });
            } catch (err) {
                console.error(`[video-producer] build ${projectId} scene ${scene.id} failed:`, err);
            }
            if (paid) await settle(scene.source === 'ai_video' ? 'video' : 'image', paid, !!made, made?.tasks);
            if (made?.asStill) {
                // No stock clip was long enough: the scene is a moving still now, and the storyboard says
                // so — the timeline holds it (sceneClips) and the Videos tab shows it as a stock photo.
                storyboard.scenes[i] = { ...scene, source: 'stock_photo', motion: scene.motion && scene.motion !== 'none' ? scene.motion : 'push_in' };
                await save({ storyboard });
            }
            if (made) done[scene.id] = made.assetId; else failed.add(i);
            await save({});
        };
        const todo = storyboard.scenes.map((_, i) => i).filter((i) => !done[storyboard.scenes[i].id]);
        // The other scenes are made in order meanwhile (stock took ~5 minutes on its own in the same
        // staging build), so a retried AI clip still fits the worker's ceiling.
        const others = (async () => { for (const i of todo) if (storyboard.scenes[i].source !== 'ai_video') await makeScene(i); })();
        await Promise.all([...todo.filter((i) => storyboard.scenes[i].source === 'ai_video').map(makeScene), others]);
        // The parallel saves can land out of order; this one writes every scene made.
        await save({});
        const missing = [...failed].sort((a, b) => a - b).map((i) => `scene ${i + 1}`);
        if (missing.length) throw new Error(`Couldn't find pictures for ${missing.join(', ')}. Change those scenes or try again — the finished scenes are kept.`);

        // 3. The post — one row per platform, one cross-post group.
        const clips = sceneClips(storyboard.scenes, done, durations, { fileS, ownSound });
        const edit: VideoEdit = { clips, targetRatio: '9:16' };
        const audio: AudioOverlay[] = voiceoverAssetId
            ? [{ id: `vp_vo_${voiceoverAssetId}`, assetId: voiceoverAssetId, label: 'Voiceover', volume: 1, fadeInS: 0.05, fadeOutS: 0.2, captions: brief.captions !== false, ...(brief.captionStyle ? { captionStyle: normalizeCaptionStyle(brief.captionStyle) } : {}) }]
            : [];
        // Footage in its own sound: captions follow what people say in it. The render reads caption
        // words from a voiceover track, so a silent track carries them (volume 0) — no render change.
        if (ownSound && brief.captions !== false) {
            const wordsByAsset = new Map(footage.map((v) => [v.id, v.words as FootageWord[]]));
            const spoken = ownSpeechOnTimeline(storyboard.scenes, durations, wordsByAsset);
            if (spoken.length) {
                const captionAssetId = await makeCaptionTrack(db, { orgId, userId, words: spoken, name: `Captions · ${storyboard.title}`.slice(0, 80) });
                audio.push({ id: `vp_cap_${captionAssetId}`, assetId: captionAssetId, label: 'Captions of what’s said', volume: 0, fadeInS: 0, fadeOutS: 0, captions: true, ...(brief.captionStyle ? { captionStyle: normalizeCaptionStyle(brief.captionStyle) } : {}) });
            }
        }
        const overlays = sceneOverlays(storyboard.scenes, durations, brief.captions !== false ? normalizeCaptionStyle(brief.captionStyle).position : 'bottom');
        const assetIds = clips.map((c) => c.assetId);
        const platforms = (brief.platforms?.length ? brief.platforms : ['instagram']).filter((x) => x in VIDEO_DESTINATIONS);
        const group = platforms.length > 1 ? (p.crosspostGroupId ?? randomUUID()) : null;
        const caption = storyboard.caption || brief.message.slice(0, 300);
        let firstPostId: number | null = null;
        for (const platform of platforms) {
            const [post] = await db.insert(scheduledPosts).values({
                userId, organisationId: orgId, assistantId: p.aiAssistantId ?? null,
                platform, postFormat: 'video', formatKey: VIDEO_DESTINATIONS[platform],
                // A placeholder slot a day out — approving it is what schedules it for real.
                publishDate: new Date(Date.now() + 24 * 3600 * 1000),
                caption, contentAssetIds: assetIds,
                imageOverlays: overlays, audioOverlays: audio, videoEdit: edit,
                status: 'pending_approval', isAutonomous: false,
                ownerId: userId, ownerLabel: 'Video Producer', generatedAt: new Date(),
                crosspostGroupId: group,
            } as typeof scheduledPosts.$inferInsert).returning({ id: scheduledPosts.id });
            if (assetIds.length) {
                await db.insert(scheduledPostAssets)
                    .values(assetIds.map((contentAssetId, position) => ({ scheduledPostId: post.id, contentAssetId, position })))
                    .onConflictDoNothing();
            }
            firstPostId ??= post.id;
        }

        // Anything still held (a scene that turned out free, say) goes back.
        if (held > 0) { await settleHold(db, { orgId, amount: held, success: false, mediaType: 'image', userId }); held = 0; }
        await save({ status: 'built', scheduledPostId: firstPostId, crosspostGroupId: group, note: null });
    } catch (err) {
        console.error(`[video-producer] build ${projectId} failed:`, err);
        // Not a fault: the user is told to change those scenes; the person who started it has left.
        if (!/^(Couldn't find pictures|The person who started)/.test(err instanceof Error ? err.message : '')) {
            await recordPlatformIncident(db, { kind: 'video_build', error: err, organisationId: orgId, role: 'video_producer', view: 'video-producer', ids: { projectId } });
        }
        if (held > 0) { await settleHold(db, { orgId, amount: held, success: false, mediaType: 'image', userId }).catch(() => {}); held = 0; }
        await save({ status: 'failed', note: err instanceof Error ? err.message.slice(0, 400) : 'The video could not be made.' }).catch(() => {});
    }
}

/** Longer than any honest plan or build runs (the worker's own ceiling is 15 minutes). */
export const STUCK_AFTER_MS = 20 * 60 * 1000;

/**
 * A worker killed mid-way (Lambda's ceiling, a deploy) leaves its project mid-step with credits held.
 * Fail it and give the hold back; the scenes already made stay on the project for a re-build.
 */
export async function sweepStuckProjects(db: Db, orgId: number, now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - STUCK_AFTER_MS);
    const stuck = await db.select({ id: videoProjects.id, creditHold: videoProjects.creditHold, createdBy: videoProjects.createdBy })
        .from(videoProjects)
        .where(and(eq(videoProjects.organisationId, orgId), inArray(videoProjects.status, ['reviewing', 'planning', 'building']), lt(videoProjects.updatedAt, cutoff)));
    for (const p of stuck) {
        // Zero the hold in the same UPDATE that claims the row, so two sweeps cannot both refund it.
        const [claimed] = await db.update(videoProjects)
            .set({ status: 'failed', creditHold: 0, note: 'This took too long and was stopped. Nothing was charged for the unfinished part — try again.', updatedAt: now })
            .where(and(eq(videoProjects.id, p.id), inArray(videoProjects.status, ['reviewing', 'planning', 'building'])))
            .returning({ id: videoProjects.id });
        if (claimed && p.creditHold > 0) await settleHold(db, { orgId, amount: p.creditHold, success: false, mediaType: 'image', userId: p.createdBy });
    }
    return stuck.length;
}

/** Hold what a build will spend. Pure-ish wrapper so the endpoint and tests share the arithmetic. */
export async function holdBuild(db: Db, orgId: number, storyboard: Storyboard, brief: VideoBrief) {
    const credits = estimateCredits(storyboard, brief, BUILD_COSTS);
    if (credits === 0) return { ok: true as const, credits: 0 };
    const hold = await holdCredits(db, { orgId, amount: credits, tasks: buildTasks(storyboard, brief), mediaType: 'video' });
    return hold.ok ? { ok: true as const, credits } : { ok: false as const, credits, balance: hold.balance, unit: hold.unit, cost: hold.cost };
}

/**
 * What making this storyboard costs, in the unit the workspace is billed in — the SAME figure the hold
 * takes (holdBuild → holdCredits). Under the single task allowance (unified_task_metering, on for
 * everyone since 2026-10-17) that is weighted tasks: 20 per AI clip, 1 per AI picture, 1 for the
 * voiceover. Before go-live the Videos tab still quoted credits (5 per clip) while the hold took tasks.
 */
export async function buildEstimate(orgId: number, storyboard: Storyboard, brief: VideoBrief): Promise<{ estimate: number; unit: 'tasks' | 'credits' }> {
    return await isUnifiedTaskMetering(orgId)
        ? { estimate: buildTasks(storyboard, brief), unit: 'tasks' }
        : { estimate: estimateCredits(storyboard, brief, BUILD_COSTS), unit: 'credits' };
}

/** A project as the review panel shows it — presigned thumbnails for the scenes already made. */
export async function projectView(db: Db, orgId: number, row: typeof videoProjects.$inferSelect) {
    const ids = Object.values((row.sceneAssets ?? {}) as Record<string, number>);
    const thumbs: Record<number, string | null> = {};
    if (ids.length) {
        const assets = await db.select({ id: contentAssets.id, storageKey: contentAssets.storageKey, externalUrl: contentAssets.externalUrl })
            .from(contentAssets).where(and(inArray(contentAssets.id, ids), eq(contentAssets.organisationId, orgId)));
        for (const a of assets) thumbs[a.id] = a.storageKey ? await presignR2Get(a.storageKey).catch(() => null) : a.externalUrl;
    }
    const sb = row.storyboard as Storyboard | null;
    // A 'built' project's post can still fail its final render (the text burn-in), and until that is
    // retried the post can never publish. The Videos tab said "Made. It's in the Review Queue" over a
    // post the Review Queue was showing as failed (SWAN-6), so it reads the post's render state too.
    let postRenderStatus: string | null = null;
    if (row.status === 'built' && row.scheduledPostId) {
        const [p] = await db.select({ renderStatus: scheduledPosts.renderStatus }).from(scheduledPosts)
            .where(and(eq(scheduledPosts.id, row.scheduledPostId), eq(scheduledPosts.organisationId, orgId))).limit(1);
        postRenderStatus = p?.renderStatus ?? null;
    }
    return {
        id: row.id, aiAssistantId: row.aiAssistantId, title: row.title, status: row.status, brief: row.brief, storyboard: sb, changes: row.changes, note: row.note,
        scheduledPostId: row.scheduledPostId, postRenderStatus, creditsSpent: row.creditsSpent,
        origin: row.origin, sourcePostId: row.sourcePostId, campaignId: row.campaignId,
        footageReview: (row.footageReview as FootageReview | null) ?? null,
        ...(sb ? await buildEstimate(orgId, sb, row.brief as VideoBrief) : { estimate: null, unit: null }),
        sceneThumbs: Object.fromEntries(Object.entries((row.sceneAssets ?? {}) as Record<string, number>).map(([k, v]) => [k, thumbs[v] ?? null])),
        createdAt: row.createdAt, updatedAt: row.updatedAt,
    };
}

/**
 * What the chat may know about this assistant's videos, per turn — ids it may name in a card, and
 * nothing it could mistake for a promise (no thumbnails, no URLs). Newest first, at most 10.
 */
export async function buildVideosSnapshot(db: Db, orgId: number, assistantId: number): Promise<string> {
    await sweepStuckProjects(db, orgId).catch(() => 0);
    const rows = await db.select().from(videoProjects)
        .where(and(eq(videoProjects.organisationId, orgId), eq(videoProjects.aiAssistantId, assistantId)))
        .orderBy(desc(videoProjects.createdAt)).limit(10);
    const footage = await ownFootageSnapshot(db, orgId).catch(() => 'THEIR OWN VIDEOS: could not be read this turn — do not name any by id.');
    if (!rows.length) return `YOUR VIDEOS: none yet.\n\n${footage}`;
    const tasks = await isUnifiedTaskMetering(orgId);
    const WAITING: Record<string, string> = {
        reviewing: 'watching their footage',
        reviewed: 'footage reviewed — suggested edits waiting for the user to tick and press "Make the storyboard"',
        planning: 'writing the storyboard', planned: 'storyboard waiting for the user to check it and press "Make the video"',
        building: 'being made', built: 'made — the finished video is in the Review Queue for approval',
        failed: 'stopped', cancelled: 'cancelled', draft: 'not started',
    };
    return ['YOUR VIDEOS (newest first; use only these ids):', ...rows.map((r) => {
        const sb = r.storyboard as Storyboard | null;
        const brief = r.brief as VideoBrief;
        const scenes = sb ? ` · ${sb.scenes.length} scenes` : '';
        const n = sb ? (tasks ? buildTasks(sb, brief) : estimateCredits(sb, brief, BUILD_COSTS)) : 0;
        const unit = tasks ? (n === 1 ? 'task' : 'tasks') : (n === 1 ? 'credit' : 'credits');
        const cost = sb && (r.status === 'planned' || r.status === 'failed') ? ` · would use ${n} ${unit} to make` : '';
        const note = r.note ? ` · note: ${r.note.slice(0, 160)}` : '';
        const from = ORIGIN_LABELS[r.origin] ? ` · ${ORIGIN_LABELS[r.origin]}` : '';
        // Its scenes, once it can still be changed: "make the opening punchier" needs the words.
        const lines = sb && (r.status === 'planned' || r.status === 'failed')
            ? sb.scenes.map((s, i) => `\n    • scene ${i + 1} (${s.beat}, ${s.source}): voiceover "${(s.voiceover || '').slice(0, 240)}"${s.onScreenText ? `; on screen "${s.onScreenText}"` : ''}${s.tightened ? `; tightened: ${describeTightening(s.tightened)}` : s.tighten === false ? '; kept as filmed' : ''}`).join('')
            : '';
        const fr = r.footageReview as FootageReview | null;
        const own = brief.footageAssetIds?.length ? ` · from their own footage (videos ${brief.footageAssetIds.join(', ')})` : '';
        const seen = fr && (r.status === 'reviewed' || r.status === 'planned')
            ? fr.seen.map((v) => `\n    • what you saw in video ${v.assetId} "${v.name.slice(0, 60)}": ${v.summary.slice(0, 200)}${v.problems.length ? ` (problems: ${v.problems.join(', ').slice(0, 160)})` : ''}`).join('')
              + fr.suggestions.map((x) => `\n    • suggestion ${x.id}${x.ticked ? '' : ' (unticked)'}: ${x.text.slice(0, 160)}`).join('')
            : '';
        return `- id ${r.id}: "${r.title.slice(0, 80)}" (${brief.lengthS}s${scenes}${from}${own}) — ${WAITING[r.status] ?? r.status}${cost}${note}${seen}${lines}`;
    }), '', footage].join('\n');
}

/**
 * The owner's own uploaded videos the chat may name in a footage card — ids, names, lengths, and what
 * was seen in the ones already reviewed. Newest 15. No URLs.
 */
export async function ownFootageSnapshot(db: Db, orgId: number): Promise<string> {
    const vids = (await ownVideos(db, orgId)).reverse().slice(0, 15);
    if (!vids.length) return 'THEIR OWN VIDEOS: none uploaded yet. They can add one with "Use my own footage" on the "Videos" tab, or in My Content.';
    const status = new Map((await footageStatus(db, orgId, vids.map((v) => v.id))).map((x) => [x.assetId, x]));
    return ['THEIR OWN VIDEOS (uploads; use only these ids in a footage card):', ...vids.map((v) => {
        const st = status.get(v.id);
        const len = st?.durationS ?? v.durationS;
        return `- video ${v.id}: "${(v.name || '').slice(0, 80)}"${len ? ` (${Math.round(len)} s)` : ''}${st?.analysed ? ` — already reviewed: ${(st.summary ?? '').slice(0, 160)}` : ' — not reviewed yet'}`;
    })].join('\n');
}
