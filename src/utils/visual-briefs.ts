// src/utils/visual-briefs.ts
// The Brand Designer's engine (docs/brand-designer-plan.md §4): a brief becomes rounds of options
// from stock, AI and branded cards; the user approves; an approved option becomes a library asset.
//
// It owns NO generation of its own. Every picture comes from machinery the product already had —
// Pexels (src/utils/pexels.ts), fal FLUX (src/lib/fal-gateway.ts) and the brand card renderer
// (src/lib/brand-card.ts) — and every approved option lands in content_assets, the same library every
// other assistant draws from.
//
// ── The money rule ──────────────────────────────────────────────────────────────────────────────
// Only AI costs anything: one AI credit per round, which buys a grid of four (the same rule as
// generate-ai-image). The credit is HELD when the user clicks, and the hold is settled exactly once
// by whoever ends the round — the worker, or the timeout sweep — in the same UPDATE that zeroes
// `credit_hold`. A round whose AI produced nothing is refunded; a round that is never picked up is
// refunded by the sweep. Nothing here spends without a human click: chat proposes, the click holds.
//
// ── Why options are not library assets ──────────────────────────────────────────────────────────
// My Content lists every content_assets row in the workspace, so a dozen candidates per brief would
// bury the user's real pictures. Options live in visual_brief_options until approved.

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { aiAssistants, campaigns, contentAssets, mediaGenerationJobs, organisations, scheduledPosts, visualBriefOptions, visualBriefs } from '../../db/schema';
import type { getDb } from '../../db/client';
import { gatewayGenerate } from '../lib/ai-gateway';
import { gatewayRoleModel } from './assistant-model';
import { ART_DIRECTION_CRAFT } from '../constants/art-direction-craft';
import { logMediaCost } from './ai-usage';
import {
    FalContentPolicyError, FalError, extractVideo, falConfigured, generateImageVariants, generateImages, result as falResult, status as falStatus,
    submitFramedVideo, imageToVideoEnabled, billedSecondsFor, i2vModel, IMAGE_MODEL, type AspectRatio,
} from '../lib/fal-gateway';
import { renderBrandCard, type CardVariant } from '../lib/brand-card';
import { deleteR2Object, persistBufferToR2, persistRemoteMediaToR2, r2IsConfigured } from '../lib/media-persist';
import { normalizeBrandKit, type BrandKit } from './brand-kit';
import { guidelinesPromptLines, hasGuidelines, readBrandGuidelines, type BrandGuidelines } from './brand-guidelines';
import { fillPrompts } from '../lib/image-prompt';
import {
    businessPromptLines, clip, colourWords, parseStoredRejection, readBriefContext, rejectionPromptSection, setupAnswer, sourceLabel, withoutColourCodes,
    type BriefContext, type PastRejection,
} from './art-direction-context';

export { colourWords, readBriefContext, setupAnswer, sourceLabel, withSetupFallback, withoutColourCodes } from './art-direction-context';
export type { BriefContext, PastRejection } from './art-direction-context';
import { holdCredits, settleHold, getBalance, tasksForCredits, IMAGE_CREDIT_COST, VIDEO_CREDIT_COST, tierCanGenerateVideo } from './ai-credits';
import { aiVideoTasks } from '../config/task-weights';
import { getActiveTierKeyByOrg } from './plan-features';
import { orgHasAssistantFeature } from './assistant-capabilities';
import { loadAssistantRulesBlock } from './assistant-rules-prompt';
import { PexelsRateLimitError, searchUniqueImages, searchUniqueVideos } from './pexels';
import { BRAND_CARD_PROVIDER } from './brand-card-lifecycle';
import { resolveAssetDisplayUrl } from './social-publish';
import { POST_ATTACH_NOTES, attachApprovedToPost, placeOnCampaignPost } from './brief-post-media';
import { DESIGN_COPY, DESIGN_PROVIDER, bakeImageDesign } from './design-options';
import { listDesignTemplates } from './design-templates';
import { designForChat, type Design } from './design-doc';
import { approveFlyerOption, brandPageColours, flyerRoundOptions, type FlyerRenderParams } from './flyer-briefs';
import { resolveBrandKitForOrg } from '../lib/brand-extract-fetch';
import { isAccentCandidate } from './brand-extract';
import { normalizeHex } from '../public/brand-contrast.js';
import { normaliseFlyerContent } from '../config/flyer-vocab';

/** Brief purposes whose pictures belong on social posts (blog and email headers have their own briefs). */
const SOCIAL_PURPOSES = new Set(['social_post', 'story', 'ad', 'other']);
import { triggerBriefRound } from './trigger-brief-round';
import { TASK_WEIGHTS, basicWorkCharged } from '../config/task-weights';
import { hasTaskCapacity, recordCompletedWork, TASK_LIMIT_MESSAGE } from './work-metering';
import {
    FLYER_PURPOSE, FLYER_SOURCE, FLYER_SOURCE_LABEL,
    GENERATION_TIMEOUT_MS, MAX_ROUNDS, OWN_SOURCE, OWN_SOURCE_LABEL, PURPOSE_SPECS, REJECT_REASON_LABELS, SOURCE_SPECS,
    normaliseBrief, sourcesAreFree,
    type BriefPurpose,
} from '../config/visual-brief-vocab';

type Db = ReturnType<typeof getDb>;
export type BriefRow = typeof visualBriefs.$inferSelect;
type OptionInsert = typeof visualBriefOptions.$inferInsert;

const AI_OPTIONS = SOURCE_SPECS.ai_image.optionsPerRound;
const STOCK_OPTIONS = SOURCE_SPECS.stock.optionsPerRound;
const CARD_VARIANTS: CardVariant[] = ['light', 'bold'];
const VIDEO_MODEL = process.env.FAL_VIDEO_MODEL ?? 'fal-ai/minimax/hailuo-2.3/standard/text-to-video';
const STOCK_VIDEO_OPTIONS = SOURCE_SPECS.stock_video.optionsPerRound;
/** How long a round waits for an AI clip. Inside the 15-minute background budget, and inside the
 *  10-minute sweep (GENERATION_TIMEOUT_MS) — a clip that has not arrived by then is refunded. */
const VIDEO_POLL_DEADLINE_MS = 8 * 60 * 1000;
const VIDEO_POLL_INTERVAL_MS = 5000;
const MOCK_VIDEO_URL = 'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4';
/**
 * Options whose bytes are OURS (in R2 under content/org-N/briefs) — the only ones deleted when turned
 * down. A stock option is a Pexels link; an "own" option IS a library picture the user already had.
 */
const GENERATED_SOURCES = new Set(['ai_image', 'brand_card', 'ai_video', FLYER_SOURCE]);

/** The Brand Designer's AI clip length — what its round holds and is charged for (aiVideoTasks). */
const BRIEF_CLIP_SECONDS = 6;
/** A source label for display, including "Your own". */
// ── Art direction ───────────────────────────────────────────────────────────────────────────────

/** The new-brief default for sources, from setup. 'free_only' never ticks AI by default. */
export function defaultSourcesFor(onboardingContext: unknown): string[] {
    return setupAnswer(onboardingContext, 'defaultSources') === 'free_only' ? ['stock', 'brand_card'] : ['stock', 'ai_image', 'brand_card'];
}

export interface ArtDirection {
    /** What FLUX is asked for. Never contains words to render — words belong on cards. */
    imagePrompt: string;
    /**
     * One prompt per AI option, imagePrompt first. One prompt drawn four times only changes the seed,
     * so the options came back as the same picture four times (see image-prompt.ts). Absent from older rounds.
     */
    imagePrompts?: string[];
    /** 2–4 words for the Pexels search (photos and videos). */
    stockKeywords: string;
    /** For the AI video model: the image prompt plus motion. Absent from older rounds. */
    videoPrompt?: string;
    /** Up to two headlines for branded cards — the brief's own words come first. */
    cardHeadlines: string[];
    /** A flyer only: up to three page colours the art director chose. Used as flyerColours (flyer-briefs.ts) says. */
    flyerColours?: string[];
    /** 'model' when Claude wrote it; 'fallback' when it could not and the brief was used as-is. */
    by: 'model' | 'fallback';
}

/**
 * The brief, used as-is. What every round falls back to when the model call fails — a round must
 * never die because art direction could not be written, since the user may already have been charged
 * a hold for it.
 */
export function fallbackArtDirection(
    brief: Pick<BriefRow, 'title' | 'message' | 'headline' | 'mood' | 'mustInclude' | 'mustAvoid'>,
    kit: BrandKit,
    house: Partial<Pick<BrandGuidelines, 'photoStyle' | 'mustInclude' | 'mustAvoid'>> = {},
): ArtDirection {
    const subject = clip(brief.message, 400) || clip(brief.headline, 200) || clip(brief.title, 120);
    const imagePrompt = [
        subject,
        brief.mood ? `Mood: ${clip(brief.mood, 200)}.` : '',
        brief.mustInclude ? `Include: ${clip(brief.mustInclude, 200)}.` : '',
        brief.mustAvoid ? `Avoid: ${clip(brief.mustAvoid, 200)}.` : '',
        house.mustAvoid ? `Never show: ${clip(house.mustAvoid, 200)}.` : '',
        house.photoStyle ? `Style: ${clip(house.photoStyle, 300)}.` : '',
        house.mustInclude ? `Where it fits, include: ${clip(house.mustInclude, 200)}.` : '',
        `Colour accents in ${colourWords(kit.primaryColor)}.`,
        'Photographic, natural light, no text, no lettering, no logos.',
    ].filter(Boolean).join(' ');
    return {
        imagePrompt: imagePrompt.slice(0, 1000),
        imagePrompts: fillPrompts([imagePrompt.slice(0, 1000)], imagePrompt.slice(0, 1000), AI_OPTIONS),
        videoPrompt: `${imagePrompt.slice(0, 850)} Slow, steady camera movement; one continuous shot.`,
        stockKeywords: clip(brief.message, 80) || clip(brief.title, 80),
        cardHeadlines: [clip(brief.headline, 120) || clip(brief.message, 120) || clip(brief.title, 120)].filter(Boolean),
        by: 'fallback',
    };
}

export function artDirectionSystemPrompt(): string {
    return `You are a brand designer's art director. From a visual brief and a brand kit you write five things, and nothing else:

1. "imagePrompt" — a prompt for an AI image model (FLUX). One paragraph, under 900 characters. Describe the scene, subject, composition, lighting and mood concretely. Steer colour towards the brand colours given. NEVER ask for words, letters, signs, captions or logos in the image — image models render text badly, and the words go on branded cards instead. Never name a real person or a trademark.
2. "imageAlternatives" — three more prompts for the same brief, under the same rules and in the same style, each a genuinely DIFFERENT picture: a different visual idea, a different main subject, a different setting and a different composition or camera angle. Not the same scene reworded. Each under 900 characters.
3. "stockKeywords" — 2 to 4 plain words to search a stock photo library (Pexels). Visual nouns, no adjectives about quality, no punctuation.
4. "videoPrompt" — a prompt for a 6-second AI video that animates the scene in "imagePrompt": the same scene with ONE simple motion (a slow push-in, a pan, people moving naturally). One continuous shot, no cuts, no words on screen. Under 900 characters.
5. "cardHeadlines" — one or two short headlines (max 90 characters each) for a typographic card in the brand's colours. If the brief gives exact words, the FIRST headline is those words unchanged. Never invent a price, a statistic, a date or an offer the brief does not state.

Respect every "must avoid" in the brief in all five. When earlier options were turned down, the reasons are listed: change what the reason names, keep what it does not.

${ART_DIRECTION_CRAFT}

Return STRICT JSON only: {"imagePrompt": "...", "imageAlternatives": ["...", "...", "..."], "stockKeywords": "...", "videoPrompt": "...", "cardHeadlines": ["..."]}`;
}

/** Added to the system prompt for a flyer: its pages are coloured, and an unset kit is not a colour scheme. */
export const FLYER_COLOUR_RULE = `This brief is a printed flyer, so also return "flyerColours": three hex colours for its page backgrounds, strongest first, chosen to suit this business, its customers and what this flyer is for.
- If MOOD names colours or a look, follow it.
- Otherwise use the BRAND COLOURS and extra brand colours, when they are real colours.
- Black, white and grey brand colours mean none has been set. Then choose a palette that fits the business, and do not steer the pictures towards black, white or grey either.
- Every one must be a real colour, never black, white or grey, and not so pale that it looks white on paper.`;

export function artDirectionUserPrompt(brief: BriefRow, ctx: BriefContext, rejections: PastRejection[]): string {
    const purpose = PURPOSE_SPECS[brief.purpose as BriefPurpose]?.label ?? brief.purpose;
    return [
        ...businessPromptLines(ctx),
        `BRIEF: "${clip(brief.title, 120)}" — a ${purpose.toLowerCase()} in ${brief.aspectRatio}.`,
        brief.message ? `WHAT IT SHOULD SHOW OR SAY: ${clip(brief.message, 1000)}` : '',
        brief.headline ? `EXACT WORDS FOR THE CARD: ${clip(brief.headline, 120)}` : '',
        brief.mood ? `MOOD: ${clip(brief.mood, 300)}` : '',
        brief.mustInclude ? `MUST INCLUDE: ${clip(brief.mustInclude, 500)}` : '',
        brief.mustAvoid ? `MUST AVOID: ${clip(brief.mustAvoid, 500)}` : '',
        rejectionPromptSection(rejections),
    ].filter(Boolean).join('\n');
}

/** Parse the model's JSON; any field it got wrong falls back to the brief's own words. */
export function parseArtDirection(raw: string, fallback: ArtDirection, exactHeadline: string | null): ArtDirection {
    let j: Record<string, unknown> = {};
    try {
        const m = raw.match(/\{[\s\S]*\}/);
        j = m ? JSON.parse(m[0]) : {};
    } catch { return fallback; }
    const imagePrompt = clip(typeof j.imagePrompt === 'string' ? withoutColourCodes(j.imagePrompt) : '', 1000);
    const alternatives = (Array.isArray(j.imageAlternatives) ? j.imageAlternatives : [])
        .filter((p): p is string => typeof p === 'string')
        .map((p) => clip(withoutColourCodes(p), 1000))
        .filter((p) => p.length >= 20);
    const stockKeywords = clip(typeof j.stockKeywords === 'string' ? j.stockKeywords.replace(/[^\p{L}\p{N}\s-]/gu, ' ') : '', 80);
    const videoPrompt = clip(typeof j.videoPrompt === 'string' ? withoutColourCodes(j.videoPrompt) : '', 1000);
    const flyerPicks = (Array.isArray(j.flyerColours) ? j.flyerColours : []).map((c) => normalizeHex(c)).filter((c): c is string => !!c && isAccentCandidate(c)).slice(0, 3);
    let heads = Array.isArray(j.cardHeadlines) ? j.cardHeadlines.filter((h): h is string => typeof h === 'string').map((h) => clip(h, 120)).filter(Boolean) : [];
    // The user's exact words are never paraphrased away, whatever the model returned.
    if (exactHeadline) heads = [clip(exactHeadline, 120), ...heads.filter((h) => h !== clip(exactHeadline, 120))];
    if (!imagePrompt && !stockKeywords && !heads.length) return fallback;
    const firstImage = imagePrompt || fallback.imagePrompt;
    return {
        imagePrompt: firstImage,
        imagePrompts: fillPrompts([firstImage, ...alternatives], firstImage, AI_OPTIONS),
        stockKeywords: stockKeywords || fallback.stockKeywords,
        videoPrompt: videoPrompt || fallback.videoPrompt,
        cardHeadlines: (heads.length ? heads : fallback.cardHeadlines).slice(0, CARD_VARIANTS.length),
        ...(flyerPicks.length ? { flyerColours: flyerPicks } : {}),
        by: 'model',
    };
}

export async function writeArtDirection(db: Db, brief: BriefRow, ctx: BriefContext, rejections: PastRejection[]): Promise<ArtDirection> {
    const fallback = fallbackArtDirection(brief, ctx.kit, ctx.guidelines);
    try {
        // The user's Rules for this assistant (its Rules tab) and the workspace-wide ones — the same
        // block its chat reads. Never throws; null when there are none.
        const rules = await loadAssistantRulesBlock(db, { assistantId: brief.aiAssistantId, organisationId: brief.organisationId });
        const res = await gatewayGenerate({
            system: artDirectionSystemPrompt() + (brief.purpose === FLYER_PURPOSE ? `\n\n${FLYER_COLOUR_RULE}` : '') + (rules ? `\n\n${rules}` : ''),
            messages: [{ role: 'user', content: artDirectionUserPrompt(brief, ctx, rejections) }],
            maxTokens: 1500,
            deadlineMs: 45_000,
            usage: { workspaceId: brief.organisationId, assistantId: brief.aiAssistantId },
            // The Brand Designer role's model (Admin ▸ Assistants ▸ Model & rules). A background round.
            ...(await gatewayRoleModel(db, 'brand_designer')),
        });
        return parseArtDirection(res.text, fallback, brief.headline);
    } catch (err) {
        console.error('[visual-briefs] art direction failed — using the brief as written:', err instanceof Error ? err.message : err);
        return fallback;
    }
}

// ── Starting and ending a round ─────────────────────────────────────────────────────────────────

export type StartRoundResult =
    | { ok: true; round: number; aiIncluded: boolean; videoIncluded: boolean; credits: number }
    | { ok: false; status: number; error: string; code?: string; cost?: number; balance?: number; unit?: 'credits' | 'tasks' };

/**
 * The click. Holds the round's credit, marks the brief generating, and returns; the caller wakes
 * the worker. AI is silently NOT included when the workspace cannot use it (the note says so), so a
 * brief with stock and cards still produces something rather than refusing outright.
 */
export async function startRound(db: Db, args: { orgId: number; brief: BriefRow }): Promise<StartRoundResult> {
    const { orgId, brief } = args;
    if (brief.status === 'generating') return { ok: false, status: 409, error: 'Options are already being made for this brief.' };
    if (brief.status === 'cancelled') return { ok: false, status: 409, error: 'This brief was cancelled.' };
    const roundCap = maxRoundsFor(brief);
    if (brief.rounds >= roundCap) {
        return { ok: false, status: 409, error: `This brief has had ${roundCap} rounds. If none of them fit, the brief probably needs changing — start a new one.` };
    }
    if (await picturesStillNeeded(db, brief) === 0) {
        return { ok: false, status: 409, error: 'This brief already has every picture it needs — no more options are required.' };
    }

    const isFlyer = brief.purpose === FLYER_PURPOSE;
    // A flyer round draws the brief's saved words — with none saved there is nothing to draw.
    if (isFlyer && !normaliseFlyerContent(brief.flyerContent).ok) {
        return { ok: false, status: 409, error: 'Write the flyer\'s words first (or ask for them to be drafted) — a round draws exactly those words.', code: 'flyer_needs_words' };
    }
    const sources = Array.isArray(brief.sources) ? (brief.sources as string[]) : [];
    const notes: string[] = [];
    let aiIncluded = sources.includes('ai_image');
    if (aiIncluded && !(await orgHasAssistantFeature(db, orgId, 'ai_image_generation'))) {
        aiIncluded = false;
        notes.push('AI images are not switched on for this workspace, so this round has none.');
    }
    // AI video: the assistant-type feature AND the plan tier, exactly as on My Content's video button.
    let videoIncluded = sources.includes('ai_video');
    if (videoIncluded) {
        const why = await videoUnavailableReason(db, orgId);
        if (why) { videoIncluded = false; notes.push(`${why} This round has no AI video.`); }
    }
    // A flyer always has its words-only page, so it always has something free to make.
    const free = isFlyer || sources.some((s) => s === 'stock' || s === 'brand_card' || s === 'stock_video');
    if (!aiIncluded && !videoIncluded && !free) {
        return { ok: false, status: 403, error: `${notes.join(' ')} This brief asks for nothing else — edit it to include stock or branded cards.`.trim(), code: 'feature_unavailable' };
    }
    const note = notes.length ? notes.join(' ') : null;

    const videoCredits = videoIncluded ? VIDEO_CREDIT_COST : 0;
    const credits = (aiIncluded ? IMAGE_CREDIT_COST : 0) + videoCredits;
    // The free sources' one task for the round, once they cost (docs/basic-work-charging.md).
    const basicTasks = free && basicWorkCharged() ? TASK_WEIGHTS.design_round : 0;
    if (credits === 0 && basicTasks > 0 && !(await hasTaskCapacity(db, orgId, basicTasks))) {
        return { ok: false, status: 402, error: TASK_LIMIT_MESSAGE, code: 'task_limit' };
    }
    if (credits > 0) {
        const hold = await holdCredits(db, {
            orgId, amount: credits,
            // Single task allowance: an image round is 1 task, a video 20 (tasksForCredits).
            tasks: basicTasks + (aiIncluded ? tasksForCredits('image', IMAGE_CREDIT_COST) : 0) + (videoIncluded ? aiVideoTasks(billedSecondsFor(BRIEF_CLIP_SECONDS)) : 0),
        });
        if (!hold.ok) return { ok: false, status: 402, error: 'insufficient_credits', code: 'insufficient_credits', cost: hold.cost, balance: hold.balance, unit: hold.unit };
    }

    const rows = await db.update(visualBriefs).set({
        status: 'generating',
        rounds: sql`${visualBriefs.rounds} + 1`,
        creditHold: credits,
        creditHoldVideo: videoCredits,
        generationStartedAt: new Date(),
        generationNote: note,
        updatedAt: new Date(),
    }).where(and(
        eq(visualBriefs.id, brief.id),
        eq(visualBriefs.organisationId, orgId),
        sql`${visualBriefs.status} NOT IN ('generating', 'cancelled')`,
        sql`${visualBriefs.rounds} < ${roundCap}`,
    )).returning({ rounds: visualBriefs.rounds });

    if (!rows.length) {
        // Someone else started a round between our read and our write. Give the hold back.
        if (credits > 0) await settleHold(db, { orgId, amount: credits, success: false, mediaType: 'image' });
        return { ok: false, status: 409, error: 'Options are already being made for this brief.' };
    }
    return { ok: true, round: rows[0].rounds, aiIncluded, videoIncluded, credits };
}

/** Why AI video cannot be made here, in words — or null when it can. Same two gates as My Content. */
export async function videoUnavailableReason(db: Db, orgId: number): Promise<string | null> {
    if (!(await orgHasAssistantFeature(db, orgId, 'ai_video_generation'))) return 'AI video is not switched on for this workspace.';
    if (!tierCanGenerateVideo(await getActiveTierKeyByOrg(db, orgId))) return 'AI video is on the Busywork Buster and Digital Employee plans.';
    return null;
}

/**
 * End the round in flight: set the brief's status from its options, zero the hold, and settle the
 * hold that was zeroed — charged only if `chargeAi` and the AI actually produced something.
 *
 * ⚠️ The old hold is read in the SAME statement that zeroes it (UPDATE … FROM a FOR UPDATE subquery),
 * and only a brief still `generating` matches. So the worker and the timeout sweep can race and the
 * credit is still settled exactly once: whichever arrives second matches nothing and settles nothing.
 */
export async function endRound(db: Db, briefId: number, outcome: {
    /** The AI IMAGES produced something — charge the image part of the hold. */
    chargeAi: boolean;
    /** The AI VIDEO produced a clip — charge the video part. Absent = refund it. */
    chargeVideo?: boolean;
    note: string | null; artDirection?: ArtDirection | null; userId?: number | null;
}): Promise<boolean> {
    const rows = await db.execute<{ organisation_id: number; ai_assistant_id: number | null; held: number; held_video: number }>(sql`
        UPDATE visual_briefs b
           SET status = CASE
                   WHEN EXISTS (SELECT 1 FROM visual_brief_options o WHERE o.brief_id = b.id AND o.status = 'approved') THEN 'approved'
                   WHEN EXISTS (SELECT 1 FROM visual_brief_options o WHERE o.brief_id = b.id AND o.status = 'proposed') THEN 'in_review'
                   ELSE 'open' END,
               credit_hold = 0,
               credit_hold_video = 0,
               generation_note = ${outcome.note},
               art_direction = COALESCE(${outcome.artDirection ? JSON.stringify(outcome.artDirection) : null}::jsonb, b.art_direction),
               updated_at = now()
          FROM (SELECT id, credit_hold AS held, credit_hold_video AS held_video FROM visual_briefs WHERE id = ${briefId} FOR UPDATE) old
         WHERE b.id = old.id AND b.status = 'generating'
     RETURNING b.organisation_id, b.ai_assistant_id, old.held, old.held_video`);
    const row = rows[0];
    if (!row) return false;
    const held = Number(row.held) || 0;
    const heldVideo = Math.min(held, Number(row.held_video) || 0);
    const heldImage = held - heldVideo;
    // Two parts, settled separately: four images arriving while the clip failed charges the image
    // credit and refunds the video credits.
    if (heldImage > 0) {
        await settleHold(db, { orgId: row.organisation_id, amount: heldImage, success: outcome.chargeAi, mediaType: 'image', userId: outcome.userId ?? null, assistantId: row.ai_assistant_id });
    }
    if (heldVideo > 0) {
        await settleHold(db, { orgId: row.organisation_id, amount: heldVideo, success: outcome.chargeVideo === true, mediaType: 'video', userId: outcome.userId ?? null, assistantId: row.ai_assistant_id, tasks: aiVideoTasks(billedSecondsFor(BRIEF_CLIP_SECONDS)) });
    }
    return true;
}

/**
 * Rounds that never finished: the worker died, or was never woken. Ended as failed and their credit
 * refunded. Called on every `list`, so the user never stares at "Making options…" for ever — the
 * campaign tab's "renders and does nothing" lesson.
 */
export async function sweepStuckRounds(db: Db, orgId: number): Promise<number> {
    const stuck = await db.select({ id: visualBriefs.id }).from(visualBriefs).where(and(
        eq(visualBriefs.organisationId, orgId),
        eq(visualBriefs.status, 'generating'),
        sql`${visualBriefs.generationStartedAt} < now() - (${GENERATION_TIMEOUT_MS} * interval '1 millisecond')`,
    ));
    let n = 0;
    for (const b of stuck) {
        if (await endRound(db, b.id, { chargeAi: false, note: 'That round took too long and was stopped. Nothing was charged — try again.' })) n++;
    }
    return n;
}

// ── The round itself (the worker) ───────────────────────────────────────────────────────────────

async function pastRejections(db: Db, briefId: number): Promise<{ rejections: PastRejection[]; shownStockIds: string[] }> {
    const rows = await db.select({
        source: visualBriefOptions.source, status: visualBriefOptions.status, reason: visualBriefOptions.rejectReason,
        prompt: visualBriefOptions.prompt, providerAssetId: visualBriefOptions.providerAssetId,
    }).from(visualBriefOptions).where(eq(visualBriefOptions.briefId, briefId));
    const rejections: PastRejection[] = [];
    for (const r of rows) {
        if (r.status !== 'rejected' || !r.reason) continue;
        rejections.push(parseStoredRejection(r.source, r.reason, r.prompt));
    }
    // Photos and videos share Pexels' id space only through the 'v' prefix on video ids (pexels.ts),
    // so one exclude list serves both searches.
    // A flyer page on a stock photo carries that photo's id, so a flyer's next round finds a new one.
    const shownStockIds = rows.filter((r) => (r.source === 'stock' || r.source === 'stock_video' || r.source === FLYER_SOURCE) && r.providerAssetId).map((r) => r.providerAssetId!);
    return { rejections, shownStockIds };
}

/** Run one round. Never throws: every exit ends the round, so the credit is always settled. */
export async function runRound(db: Db, briefId: number, userId: number | null): Promise<void> {
    const [brief] = await db.select().from(visualBriefs).where(and(eq(visualBriefs.id, briefId), eq(visualBriefs.status, 'generating'))).limit(1);
    if (!brief) return;

    let aiProduced = false;
    let videoProduced = false;
    let basicsProduced = false;
    let artDirection: ArtDirection | null = null;
    const notes: string[] = brief.generationNote ? [brief.generationNote] : [];
    try {
        const read = await readBriefContext(db, brief.organisationId, brief.aiAssistantId);
        // A kit nobody has set is read from their website first, as the drafting path does. Without
        // this, a workspace whose posts never used a branded card drew every option in black and white.
        const ctx = { ...read, kit: await resolveBrandKitForOrg(db, brief.organisationId).catch(() => read.kit) };
        const { rejections, shownStockIds } = await pastRejections(db, brief.id);
        const sources = Array.isArray(brief.sources) ? (brief.sources as string[]) : [];
        const base = { organisationId: brief.organisationId, briefId: brief.id, round: brief.rounds };

        if (brief.purpose === FLYER_PURPOSE) {
            // The photo is art-directed from what the flyer says when the brief itself says little.
            const words = normaliseFlyerContent(brief.flyerContent);
            const forArt = words.ok && !brief.message
                ? { ...brief, message: [words.content.headline, words.content.subheading].filter(Boolean).join('. ') }
                : brief;
            const wantPhoto = sources.includes('stock') || sources.includes('ai_image');
            // A words-only flyer still needs the art director when there are colours to choose.
            const needsColours = !!brief.mood || !brandPageColours(ctx.kit, ctx.guidelines.secondaryColors).length;
            artDirection = wantPhoto || needsColours ? await writeArtDirection(db, forArt, ctx, rejections) : fallbackArtDirection(forArt, ctx.kit, ctx.guidelines);
            const imageHeld = brief.creditHold - brief.creditHoldVideo;
            const r = await flyerRoundOptions(db, {
                brief, ad: artDirection, ctx, userId, shownStockIds,
                wantStock: sources.includes('stock'), wantAi: sources.includes('ai_image') && imageHeld >= IMAGE_CREDIT_COST,
            });
            notes.push(...r.notes);
            aiProduced = r.aiUsed;
            if (r.options.length) await db.insert(visualBriefOptions).values(r.options.map((o) => ({ ...base, ...o })));
            basicsProduced = r.options.length > 0;
            return;
        }

        artDirection = await writeArtDirection(db, brief, ctx, rejections);
        const ad = artDirection;

        // The video part of the hold is the authority for AI video, and the rest for AI images — a
        // source the user ticked but could not have (startRound's note) holds nothing and runs nothing.
        const imageHeld = brief.creditHold - brief.creditHoldVideo;
        const [stock, ai, cards, stockVideo, aiVideo] = await Promise.allSettled([
            sources.includes('stock') ? stockOptions(db, brief, ad, shownStockIds) : Promise.resolve([]),
            sources.includes('ai_image') && imageHeld >= IMAGE_CREDIT_COST ? aiOptions(db, brief, ad, userId) : Promise.resolve([]),
            sources.includes('brand_card') ? cardOptions(brief, ad, ctx) : Promise.resolve([]),
            sources.includes('stock_video') ? stockVideoOptions(db, brief, ad, shownStockIds) : Promise.resolve([]),
            sources.includes('ai_video') && brief.creditHoldVideo >= VIDEO_CREDIT_COST ? aiVideoOptions(db, brief, ad, userId) : Promise.resolve([]),
        ]);

        const options: OptionInsert[] = [];
        const take = (r: PromiseSettledResult<Omit<OptionInsert, 'organisationId' | 'briefId' | 'round'>[]>, failNote: (e: unknown) => string) => {
            if (r.status === 'fulfilled') options.push(...r.value.map((o) => ({ ...base, ...o })));
            else notes.push(failNote(r.reason));
        };
        take(stock, (e) => e instanceof PexelsRateLimitError ? 'Stock search is resting for a few minutes, so there are no stock photos this round.' : 'Stock search failed this round.');
        take(ai, (e) => e instanceof FalContentPolicyError
            ? 'The AI image service refused this brief as written. Nothing was charged. Try rewording what it should show.'
            : 'AI images could not be made this round. Nothing was charged for them.');
        take(cards, (e) => e instanceof Error && e.message === 'brand_card_requires_r2'
            ? 'Branded cards need file storage, which is not set up here.'
            : 'Branded cards could not be drawn this round.');
        take(stockVideo, (e) => e instanceof PexelsRateLimitError ? 'Stock search is resting for a few minutes, so there are no stock videos this round.' : 'Stock video search failed this round.');
        take(aiVideo, (e) => e instanceof FalContentPolicyError
            ? 'The AI video service refused this brief as written. Nothing was charged for it.'
            : e instanceof Error && e.message === 'video_timeout'
                ? 'The AI video took too long and was abandoned. Nothing was charged for it.'
                : 'The AI video could not be made this round. Nothing was charged for it.');
        aiProduced = ai.status === 'fulfilled' && ai.value.length > 0;
        videoProduced = aiVideo.status === 'fulfilled' && aiVideo.value.length > 0;

        if (sources.includes('stock') && stock.status === 'fulfilled' && !stock.value.length) {
            notes.push('No new stock photos matched — the search words are shown under the brief.');
        }
        if (options.length) await db.insert(visualBriefOptions).values(options);
        basicsProduced = options.some((o) => o.source === 'stock' || o.source === 'brand_card' || o.source === 'stock_video');
    } catch (err) {
        console.error('[visual-briefs] round failed:', briefId, err instanceof Error ? err.message : err);
        notes.push('Something went wrong making options. Nothing was charged for anything that was not made — try again.');
    } finally {
        const ended = await endRound(db, briefId, { chargeAi: aiProduced, chargeVideo: videoProduced, note: notes.length ? notes.join(' ') : null, artDirection, userId });
        // Only the call that ended the round charges, so a race with the timeout sweep charges nothing twice.
        if (ended && basicsProduced && basicWorkCharged()) {
            await recordCompletedWork(db, brief.organisationId, 'design_round', { ref: `brief-${brief.id}-round-${brief.rounds}`, assistantId: brief.aiAssistantId });
        }
    }
}

async function stockOptions(db: Db, brief: BriefRow, ad: ArtDirection, exclude: string[]) {
    const { keywords, candidates } = await searchUniqueImages(db, brief.organisationId, brief.message || brief.title, {
        limit: STOCK_OPTIONS, keywords: ad.stockKeywords, exclude,
    });
    return candidates.map((c) => ({
        source: 'stock', externalUrl: c.url, mimeType: 'image/jpeg', width: c.width || null, height: c.height || null,
        prompt: keywords, providerAssetId: c.providerAssetId, attributionName: c.photographer, attributionUrl: c.photographerUrl,
    }));
}

/**
 * Four different FLUX pictures for one credit, each from its own prompt and copied into R2 at once — fal's URLs expire within
 * hours and a brief can sit in review for days. Every attempt writes a media_generation_jobs row, so
 * the platform-wide failure alert (check-provider-balances) sees this path like every other.
 */
async function aiOptions(db: Db, brief: BriefRow, ad: ArtDirection, userId: number | null) {
    const aspectRatio = brief.aspectRatio as AspectRatio;
    const job = {
        organisationId: brief.organisationId, userId, assistantId: brief.aiAssistantId, mediaType: 'image',
        prompt: ad.imagePrompt, aspectRatio, model: IMAGE_MODEL, creditCost: IMAGE_CREDIT_COST,
    };
    // A round written before imagePrompts existed still gets four different framings.
    const prompts = fillPrompts(ad.imagePrompts?.length ? ad.imagePrompts : [ad.imagePrompt], ad.imagePrompt, AI_OPTIONS);
    let images;
    try {
        images = falConfigured()
            ? await generateImageVariants({ prompts, aspectRatio, usage: { workspaceId: brief.organisationId, userId, assistantId: brief.aiAssistantId } })
            : prompts.map((prompt, i) => ({ prompt, url: `https://picsum.photos/seed/brief-${brief.id}-${brief.rounds}-${i}/1024/1024`, width: 1024, height: 1024, contentType: 'image/jpeg' }));
    } catch (err) {
        const flagged = err instanceof FalContentPolicyError;
        await db.insert(mediaGenerationJobs).values({
            ...job, status: flagged ? 'flagged' : 'failed',
            errorMessage: `[brand-designer] ${err instanceof FalError || flagged ? (err as Error).message : 'generation failed'}`.slice(0, 1000),
        }).catch(() => {});
        throw err;
    }
    const out = [];
    for (const img of images) {
        const mimeType = img.contentType || 'image/png';
        let storageKey: string | null = null;
        let externalUrl: string | null = null;
        if (r2IsConfigured()) {
            try {
                storageKey = (await persistRemoteMediaToR2({ orgId: brief.organisationId, url: img.url, contentType: mimeType, folder: 'briefs', label: 'AI option' })).storageKey;
            } catch { continue; }   // one lost download is one fewer option, not a failed round
        } else {
            externalUrl = img.url;
        }
        // This picture's OWN prompt: a rejection's reason is read back against what made it.
        out.push({ source: 'ai_image', storageKey, externalUrl, mimeType, width: img.width || null, height: img.height || null, prompt: img.prompt });
    }
    await db.insert(mediaGenerationJobs).values({
        ...job, status: out.length ? 'completed' : 'failed',
        errorMessage: out.length ? null : '[brand-designer] generated, but no image could be stored',
        candidates: images.map((i) => ({ url: i.url, width: i.width, height: i.height, contentType: i.contentType })),
    }).catch(() => {});
    return out;
}

async function stockVideoOptions(db: Db, brief: BriefRow, ad: ArtDirection, exclude: string[]) {
    const { keywords, candidates } = await searchUniqueVideos(db, brief.organisationId, brief.message || brief.title, {
        limit: STOCK_VIDEO_OPTIONS, keywords: ad.stockKeywords, exclude,
    });
    return candidates.map((c) => ({
        source: 'stock_video', externalUrl: c.url, mimeType: 'video/mp4', width: c.width || null, height: c.height || null,
        prompt: keywords, providerAssetId: c.providerAssetId, attributionName: c.photographer, attributionUrl: c.photographerUrl,
    }));
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/**
 * One 6-second AI clip, waited for inside the round (the round already runs in a background
 * function with 15 minutes) and copied into R2 — fal's URLs expire. Every attempt writes a
 * media_generation_jobs row, so the platform-wide failure alert sees this path too. A clip that has
 * not arrived by VIDEO_POLL_DEADLINE_MS is abandoned and refunded rather than left to the sweep.
 */
// Since 2026-10-31 (Video Producer plan, Phase 1) the clip starts from a FLUX frame drawn at the
// brief's aspect ratio and is animated by an image-to-video model — so a 9:16 brief gets a 9:16 clip
// that looks like the AI image options next to it. FAL_I2V_MODEL='off' restores Hailuo text-to-video.
async function aiVideoOptions(db: Db, brief: BriefRow, ad: ArtDirection, userId: number | null) {
    const prompt = ad.videoPrompt || ad.imagePrompt;
    const usage = { workspaceId: brief.organisationId, userId, assistantId: brief.aiAssistantId };
    const job = {
        organisationId: brief.organisationId, userId, assistantId: brief.aiAssistantId, mediaType: 'video',
        prompt, aspectRatio: brief.aspectRatio, durationSeconds: BRIEF_CLIP_SECONDS,
        model: imageToVideoEnabled() ? i2vModel() : VIDEO_MODEL, creditCost: VIDEO_CREDIT_COST,
    };
    let url: string;
    let contentType = 'video/mp4';
    try {
        if (!falConfigured()) {
            url = MOCK_VIDEO_URL;
        } else {
            const sub = await submitFramedVideo({
                prompt, imagePrompt: ad.imagePrompt, aspectRatio: brief.aspectRatio as AspectRatio, durationSeconds: BRIEF_CLIP_SECONDS, usage,
            });
            const deadline = Date.now() + VIDEO_POLL_DEADLINE_MS;
            while ((await falStatus(sub.statusUrl)) !== 'COMPLETED') {
                if (Date.now() > deadline) throw new Error('video_timeout');
                await sleep(VIDEO_POLL_INTERVAL_MS);
            }
            const v = extractVideo(await falResult(sub.responseUrl));
            logMediaCost(sub.model, { durationSeconds: sub.billedSeconds }, { ...usage, sessionId: 'fal-video' });
            url = v.url;
            contentType = v.contentType || contentType;
        }
    } catch (err) {
        const flagged = err instanceof FalContentPolicyError;
        await db.insert(mediaGenerationJobs).values({
            ...job, status: flagged ? 'flagged' : 'failed',
            errorMessage: `[brand-designer] ${err instanceof Error ? err.message : 'video generation failed'}`.slice(0, 1000),
        }).catch(() => {});
        throw err;
    }
    let storageKey: string | null = null;
    let externalUrl: string | null = null;
    if (r2IsConfigured()) {
        storageKey = (await persistRemoteMediaToR2({ orgId: brief.organisationId, url, contentType, folder: 'briefs', label: 'AI video option' })).storageKey;
    } else {
        externalUrl = url;
    }
    await db.insert(mediaGenerationJobs).values({ ...job, status: 'completed' }).catch(() => {});
    return [{ source: 'ai_video', storageKey, externalUrl, mimeType: contentType, width: null, height: null, prompt }];
}

async function cardOptions(brief: BriefRow, ad: ArtDirection, ctx: BriefContext) {
    if (!r2IsConfigured()) throw new Error('brand_card_requires_r2');
    const out = [];
    for (let i = 0; i < CARD_VARIANTS.length; i++) {
        const headline = ad.cardHeadlines[i] ?? ad.cardHeadlines[0];
        if (!headline) break;
        const card = await renderBrandCard({ headline, kit: ctx.kit, aspectRatio: brief.aspectRatio as AspectRatio, variant: CARD_VARIANTS[i], orgName: ctx.orgName });
        const { storageKey } = await persistBufferToR2({ orgId: brief.organisationId, bytes: card.png, contentType: 'image/png', folder: 'briefs' });
        out.push({
            source: 'brand_card', storageKey, mimeType: 'image/png', width: card.width, height: card.height, prompt: card.headline,
            // Everything the card editor needs to reopen this exact card once it is in the library —
            // the same shape renderAndPersistBrandCard stores. The kit is stored WHOLE: a later kit
            // change must not restyle a card the user already approved.
            renderParams: { kind: 'brand_card', headline: card.headline, variant: card.variant, kit: ctx.kit, layout: card.layout },
        });
    }
    return out;
}

// ── Deciding ────────────────────────────────────────────────────────────────────────────────────

/**
 * A brief for N pictures (a campaign's 10 posts) may need more rounds than one picture does: never
 * fewer than MAX_ROUNDS, and at least one round per picture it is for.
 */
export function maxRoundsFor(brief: { picturesNeeded?: number | null }): number {
    return Math.max(MAX_ROUNDS, Number(brief.picturesNeeded) || 1);
}

/** How many more pictures this brief is for — 0 once enough are chosen. */
async function picturesStillNeeded(db: Db, brief: { id: number; picturesNeeded?: number | null }): Promise<number> {
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(visualBriefOptions)
        .where(and(eq(visualBriefOptions.briefId, brief.id), eq(visualBriefOptions.status, 'approved')));
    return Math.max(0, (Number(brief.picturesNeeded) || 1) - Number(n));
}

/**
 * Recompute a brief's status from its options. Leaves a generating or cancelled brief alone.
 * 'approved' (done) only once as many pictures are chosen as the brief is for — a brief for ten
 * posts with three chosen is still waiting on the user.
 */
async function settleBriefStatus(db: Db, briefId: number): Promise<void> {
    await db.execute(sql`
        UPDATE visual_briefs b
           SET status = CASE
                   WHEN (SELECT count(*) FROM visual_brief_options o WHERE o.brief_id = b.id AND o.status = 'approved') >= b.pictures_needed THEN 'approved'
                   WHEN EXISTS (SELECT 1 FROM visual_brief_options o WHERE o.brief_id = b.id AND o.status = 'proposed') THEN 'in_review'
                   ELSE 'open' END,
               updated_at = now()
         WHERE b.id = ${briefId} AND b.status NOT IN ('generating', 'cancelled')`);
}

export type DecideResult =
    | { ok: true; contentAssetId?: number; postNote?: string; chosen?: number; needed?: number }
    | { ok: false; status: number; error: string };

/** How many of the brief's pictures are chosen now, for the "3 of 10" the tab and chat say back. */
async function progressOf(db: Db, brief: BriefRow): Promise<{ chosen: number; needed: number }> {
    const needed = Number(brief.picturesNeeded) || 1;
    return { chosen: needed - await picturesStillNeeded(db, brief), needed };
}

/**
 * After an approval, put the picture where it was for:
 *   - a brief raised for ONE post (Phase 5) → that post, if it still has no picture;
 *   - a campaign brief for social pictures → one of the campaign's posts still awaiting review,
 *     replacing the picture the drafter found itself (owner, 2026-10-14: "swap onto waiting posts").
 *     A picture the user chose is never replaced; with no such post the picture waits in the
 *     campaign's pictures for the next post drafted.
 */
async function placeOnPost(db: Db, brief: BriefRow, orgId: number, assetId: number): Promise<string | undefined> {
    if (brief.scheduledPostId) return POST_ATTACH_NOTES[await attachApprovedToPost(db, { orgId, postId: brief.scheduledPostId, assetId })];
    if (brief.campaignId && SOCIAL_PURPOSES.has(brief.purpose)) {
        const placed = await placeOnCampaignPost(db, { orgId, campaignId: brief.campaignId, assetId });
        return placed
            ? 'It is now on one of the campaign\'s posts waiting for your review, in place of the picture the Social Media Assistant found.'
            : 'It will go on the campaign\'s next post — none of the posts drafted so far can take it.';
    }
    return undefined;
}

/**
 * Approve: the option becomes a content_assets row in the library, from where every assistant can
 * use it. Reject: the reason is kept for the next round's art direction, and our own copy of the
 * picture is deleted (a stock option is only ever a link, so there is nothing of ours to delete).
 *
 * The option is claimed with a conditional UPDATE first (proposed → decided), so a double click, or
 * the tab and a chat card at once, decides it once.
 */
export async function decideOption(db: Db, args: {
    orgId: number; userId: number; optionId: number; decision: 'approve' | 'reject'; reason?: string | null; note?: string | null;
}): Promise<DecideResult> {
    const { orgId, userId, optionId } = args;
    const [opt] = await db.select().from(visualBriefOptions)
        .where(and(eq(visualBriefOptions.id, optionId), eq(visualBriefOptions.organisationId, orgId))).limit(1);
    if (!opt) return { ok: false, status: 404, error: 'That option does not exist.' };
    if (opt.status !== 'proposed') return { ok: false, status: 409, error: `That option was already ${opt.status}.` };
    const [brief] = await db.select().from(visualBriefs).where(eq(visualBriefs.id, opt.briefId)).limit(1);
    if (!brief || brief.status === 'cancelled') return { ok: false, status: 409, error: 'That brief was cancelled.' };

    if (args.decision === 'reject') {
        const key = args.reason && (REJECT_REASON_LABELS as Record<string, string>)[args.reason] ? args.reason : 'other';
        const note = clip(args.note, 300);
        const claimed = await db.update(visualBriefOptions)
            .set({ status: 'rejected', rejectReason: note ? `${key}: ${note}` : key, decidedAt: new Date() })
            .where(and(eq(visualBriefOptions.id, optionId), eq(visualBriefOptions.status, 'proposed')))
            .returning({ id: visualBriefOptions.id });
        if (!claimed.length) return { ok: false, status: 409, error: 'That option was already decided.' };
        if (opt.storageKey && GENERATED_SOURCES.has(opt.source)) await deleteR2Object(opt.storageKey);
        await settleBriefStatus(db, brief.id);
        return { ok: true };
    }

    // A campaign brief is for a set number of pictures. Once they are chosen, "no more required"
    // means exactly that — an extra would have no post to go on.
    if (brief.campaignId && await picturesStillNeeded(db, brief) === 0) {
        return { ok: false, status: 409, error: `All ${brief.picturesNeeded} pictures this brief is for are chosen — no more are needed.` };
    }

    const claimed = await db.update(visualBriefOptions)
        .set({ status: 'approved', decidedAt: new Date() })
        .where(and(eq(visualBriefOptions.id, optionId), eq(visualBriefOptions.status, 'proposed')))
        .returning({ id: visualBriefOptions.id });
    if (!claimed.length) return { ok: false, status: 409, error: 'That option was already decided.' };

    // "Your own" (an upload or a library picture): it is ALREADY a library asset, so approving it
    // makes no copy — the option simply points at it. Only the campaign link (Phase 3) follows.
    if (opt.source === OWN_SOURCE && opt.contentAssetId) {
        await settleBriefStatus(db, brief.id);
        if (brief.campaignOrderId) await settleCampaignOrder(db, brief.id);
        return { ok: true, contentAssetId: opt.contentAssetId, postNote: await placeOnPost(db, brief, orgId, opt.contentAssetId), ...await progressOf(db, brief) };
    }

    try {
        // A flyer becomes its print PDFs (flyer-briefs.ts), not a copy of the preview picture.
        if (opt.source === FLYER_SOURCE) {
            const assetId = await approveFlyerOption(db, { orgId, userId, title: clip(brief.title, 120) || 'Flyer', option: opt });
            await db.update(visualBriefOptions).set({ contentAssetId: assetId }).where(eq(visualBriefOptions.id, optionId));
            await settleBriefStatus(db, brief.id);
            return { ok: true, contentAssetId: assetId, postNote: 'The flyer is in My Content, ready to print or download as a PDF.', ...await progressOf(db, brief) };
        }
        // Changed in the studio: what goes in the library is the design as it now looks.
        const baked = await bakeImageDesign(orgId, opt.renderParams);
        const o = baked ? { ...opt, ...baked } : opt;
        const isVideo = (o.mimeType || '').startsWith('video/');
        const isDesignCopy = (opt.renderParams as { kind?: unknown } | null)?.kind === DESIGN_COPY;
        const name = clip(`${brief.title} — ${isDesignCopy ? opt.prompt : sourceLabel(o.source).replace(/s$/, '')}`, 120);
        const common = {
            userId, organisationId: orgId, name, assetType: isVideo ? 'video' : 'image', mimeType: o.mimeType,
            width: o.width, height: o.height, aspectRatio: brief.aspectRatio, status: 'pending',
        };
        const values = opt.source === 'stock' || opt.source === 'stock_video'
            ? { ...common, storageKey: o.storageKey, externalUrl: o.externalUrl, provider: 'pexels', providerAssetId: opt.providerAssetId, attributionName: opt.attributionName, attributionUrl: opt.attributionUrl }
            : isDesignCopy
                // A design, not a text card: the branded-card editor could only replace it with a card of its own.
                ? { ...common, storageKey: o.storageKey, externalUrl: o.externalUrl, provider: DESIGN_PROVIDER, prompt: opt.prompt, libraryKeptAt: new Date() }
            : opt.source === 'brand_card'
                // libraryKeptAt: a card a human approved is not transient media — without it the
                // 30-day unused-card sweep (brand-card-lifecycle.ts) would delete it from the library.
                ? { ...common, storageKey: o.storageKey, externalUrl: o.externalUrl, provider: BRAND_CARD_PROVIDER, prompt: opt.prompt, renderParams: opt.renderParams, libraryKeptAt: new Date() }
                : { ...common, storageKey: o.storageKey, externalUrl: o.externalUrl, provider: 'fal', prompt: opt.prompt };
        const [asset] = await db.insert(contentAssets).values(values).returning({ id: contentAssets.id });
        await db.update(visualBriefOptions).set({ contentAssetId: asset.id }).where(eq(visualBriefOptions.id, optionId));
        await settleBriefStatus(db, brief.id);
        if (brief.campaignOrderId) await settleCampaignOrder(db, brief.id);
        return { ok: true, contentAssetId: asset.id, postNote: await placeOnPost(db, brief, orgId, asset.id), ...await progressOf(db, brief) };
    } catch (err) {
        // Give the option back rather than leave it "approved" with nothing in the library.
        await db.update(visualBriefOptions).set({ status: 'proposed', decidedAt: null }).where(eq(visualBriefOptions.id, optionId));
        console.error('[visual-briefs] approve failed:', optionId, err instanceof Error ? err.message : err);
        return {
            ok: false, status: 500,
            error: err instanceof Error && err.message === 'flyer_photo_unavailable'
                ? 'The photo on that flyer could not be fetched just now, so the PDF was not made — please try again.'
                : 'Could not add that to your library — please try again.',
        };
    }
}

/** Cancel a brief. Unreviewed AI/card options are deleted from storage; approved ones stay in the library. */
export async function cancelBrief(db: Db, orgId: number, briefId: number): Promise<{ ok: boolean; error?: string }> {
    const rows = await db.update(visualBriefs).set({ status: 'cancelled', updatedAt: new Date() })
        .where(and(eq(visualBriefs.id, briefId), eq(visualBriefs.organisationId, orgId), sql`${visualBriefs.status} NOT IN ('generating', 'cancelled')`))
        .returning({ id: visualBriefs.id });
    if (!rows.length) return { ok: false, error: 'That brief is being worked on or is already cancelled.' };
    const leftovers = await db.select({ id: visualBriefOptions.id, key: visualBriefOptions.storageKey, source: visualBriefOptions.source })
        .from(visualBriefOptions).where(and(eq(visualBriefOptions.briefId, briefId), eq(visualBriefOptions.status, 'proposed')));
    for (const o of leftovers) if (o.key && GENERATED_SOURCES.has(o.source)) await deleteR2Object(o.key);
    if (leftovers.length) {
        await db.update(visualBriefOptions).set({ status: 'rejected', rejectReason: 'other: brief cancelled', decidedAt: new Date() })
            .where(inArray(visualBriefOptions.id, leftovers.map((o) => o.id)));
    }
    await settleCampaignOrder(db, briefId);
    return { ok: true };
}

/**
 * A brief a campaign commissioned (Phase 3): settle its order NOW rather than at the next hourly
 * reconcile — the approved picture joins the campaign, and anything waiting on it is released.
 * Best-effort: the decision is already saved, and the reconciler settles anything this misses.
 * The reconciler is imported LAZILY — it imports campaign-orders, which imports this module.
 */
async function settleCampaignOrder(db: Db, briefId: number): Promise<void> {
    try {
        const [{ settleOrderNow }, { settleVisualOrder }] = await Promise.all([
            import('./campaign-reconciler'), import('./campaign-visual-order'),
        ]);
        await settleVisualOrder(db, briefId, settleOrderNow);
    } catch (err) {
        console.error('[visual-briefs] campaign order settle failed — the hourly reconcile will retry:', briefId, err instanceof Error ? err.message : err);
    }
}

// ── A post with no picture (Phase 5) ────────────────────────────────────────────────────────────

/**
 * Raise a brief for a social draft that has no picture — called by the drafting job when every media
 * source came back empty. Returns the brief id,
 * or null when there is no Brand Designer to ask (or the post is not this organisation's).
 *
 * - ONE open brief per post: a retried job, or a second click, returns the one that exists.
 * - Its sources are the Brand Designer's own defaults (a video post asks for stock video only), and
 *   its first round starts at once ONLY when those are all free — the same rule as a campaign's
 *   commission. An AI round waits for "Make options", where the cost is shown. Raising a brief
 *   never spends a credit.
 * - Never throws: on the drafting path a picture must never fail a draft.
 */
export async function raiseBriefForPost(db: Db, args: {
    orgId: number; postId: number; context: string; mediaType?: 'image' | 'video'; platform?: string | null;
}): Promise<number | null> {
    try {
        const [post] = await db.select({ id: scheduledPosts.id }).from(scheduledPosts)
            .where(and(eq(scheduledPosts.id, args.postId), eq(scheduledPosts.organisationId, args.orgId))).limit(1);
        if (!post) return null;
        const [designer] = await db.select({ id: aiAssistants.id, onboardingContext: aiAssistants.onboardingContext })
            .from(aiAssistants)
            .where(and(eq(aiAssistants.organisationId, args.orgId), sql`(${aiAssistants.configuration} ->> 'type') = 'brand_designer'`))
            .orderBy(desc(aiAssistants.id)).limit(1);
        if (!designer) return null;
        const [open] = await db.select({ id: visualBriefs.id }).from(visualBriefs).where(and(
            eq(visualBriefs.organisationId, args.orgId), eq(visualBriefs.scheduledPostId, args.postId),
            sql`${visualBriefs.status} <> 'cancelled'`,
        )).limit(1);
        if (open) return open.id;

        const isVideo = args.mediaType === 'video';
        const n = normaliseBrief({
            title: `A ${isVideo ? 'video' : 'picture'} for a${args.platform ? ` ${args.platform}` : ''} post`.slice(0, 120),
            message: clip(args.context, 1000) || 'A picture for this post',
            purpose: isVideo ? 'story' : 'social_post',
            sources: isVideo ? ['stock_video'] : defaultSourcesFor(designer.onboardingContext),
        });
        if (!n.ok) return null;
        const [row] = await db.insert(visualBriefs).values({
            organisationId: args.orgId, aiAssistantId: designer.id, createdBy: null,
            ...n.brief, origin: 'assistant', scheduledPostId: args.postId,
        }).returning();
        if (sourcesAreFree(n.brief.sources)) {
            const started = await startRound(db, { orgId: args.orgId, brief: row });
            if (started.ok && !(await triggerBriefRound(row.id, null))) {
                await endRound(db, row.id, { chargeAi: false, note: 'Could not start making options — ask for options again to retry.' });
            }
        }
        return row.id;
    } catch (err) {
        console.error('[visual-briefs] could not raise a brief for post', args.postId, err instanceof Error ? err.message : err);
        return null;
    }
}

// ── "Add your own" ──────────────────────────────────────────────────────────────────────────────

/** How many pictures one "Add your own" may bring — a picker, not a bulk import. */
export const MAX_OWN_PER_ADD = 8;

/**
 * Add the user's own pictures to a brief as options: an upload (made into a library asset first,
 * through My Content's own upload + safety check) or anything already in the library — which is
 * where a Canva import lands, so this is also how a Canva design joins a brief. Every id is checked
 * against THIS organisation's library; another tenant's id is silently not added (an IDOR probe
 * learns nothing) and the result names exactly what was added.
 *
 * The option points at the existing asset (content_asset_id) and copies nothing: approving it costs
 * nothing, and turning it down deletes nothing — it was the user's picture before the brief existed.
 */
export async function addOwnOptions(db: Db, args: { orgId: number; briefId: number; contentAssetIds: number[] })
    : Promise<{ ok: true; added: number[] } | { ok: false; status: number; error: string }> {
    const [brief] = await db.select().from(visualBriefs)
        .where(and(eq(visualBriefs.id, args.briefId), eq(visualBriefs.organisationId, args.orgId))).limit(1);
    if (!brief) return { ok: false, status: 404, error: 'Brief not found.' };
    if (brief.status === 'cancelled') return { ok: false, status: 409, error: 'This brief was cancelled.' };
    const ids = [...new Set(args.contentAssetIds.filter((n) => Number.isInteger(n) && n > 0))].slice(0, MAX_OWN_PER_ADD);
    if (!ids.length) return { ok: false, status: 400, error: 'Choose at least one picture.' };
    const owned = await db.select({
        id: contentAssets.id, assetType: contentAssets.assetType, mimeType: contentAssets.mimeType,
        width: contentAssets.width, height: contentAssets.height, name: contentAssets.name, status: contentAssets.status,
    }).from(contentAssets).where(and(
        eq(contentAssets.organisationId, args.orgId),
        inArray(contentAssets.id, ids),
        sql`${contentAssets.purgedAt} IS NULL`,
        inArray(contentAssets.assetType, ['image', 'video']),
        // A file the safety check rejected never becomes a picture anyone can approve.
        sql`${contentAssets.status} <> 'rejected'`,
    ));
    const existing = await db.select({ assetId: visualBriefOptions.contentAssetId }).from(visualBriefOptions)
        .where(and(eq(visualBriefOptions.briefId, brief.id), eq(visualBriefOptions.source, OWN_SOURCE)));
    const already = new Set(existing.map((e) => e.assetId));
    const fresh = owned.filter((a) => !already.has(a.id));
    if (fresh.length) {
        await db.insert(visualBriefOptions).values(fresh.map((a) => ({
            organisationId: args.orgId, briefId: brief.id, round: Math.max(brief.rounds, 1), source: OWN_SOURCE,
            mimeType: a.mimeType || (a.assetType === 'video' ? 'video/mp4' : 'image/jpeg'), width: a.width, height: a.height,
            prompt: a.name, contentAssetId: a.id,
        })));
        // Their picture has arrived — the brief is no longer only "waiting on" them.
        await db.update(visualBriefs).set({ waitingOn: null, updatedAt: new Date() })
            .where(and(eq(visualBriefs.id, brief.id), sql`${visualBriefs.status} <> 'generating'`));
        await settleBriefStatus(db, brief.id);
    }
    return { ok: true, added: fresh.map((a) => a.id) };
}

/** The library, for the "Add your own" picker: newest images and videos with signed display URLs. */
export async function listLibraryForPicker(db: Db, orgId: number, limit = 60) {
    const rows = await db.select({
        id: contentAssets.id, name: contentAssets.name, assetType: contentAssets.assetType, provider: contentAssets.provider,
        storageUrl: contentAssets.storageUrl, storageKey: contentAssets.storageKey, externalUrl: contentAssets.externalUrl,
    }).from(contentAssets).where(and(
        eq(contentAssets.organisationId, orgId),
        sql`${contentAssets.purgedAt} IS NULL`,
        inArray(contentAssets.assetType, ['image', 'video']),
        sql`${contentAssets.status} <> 'rejected'`,
    )).orderBy(desc(contentAssets.createdAt)).limit(limit);
    const out = [];
    for (const a of rows) {
        out.push({ id: a.id, name: a.name, assetType: a.assetType, fromCanva: a.provider === 'canva', url: await resolveAssetDisplayUrl(a) });
    }
    return out;
}

// ── Reading ─────────────────────────────────────────────────────────────────────────────────────

export interface BriefView {
    id: number; title: string; purpose: string; aspectRatio: string; message: string | null; headline: string | null;
    mood: string | null; mustInclude: string | null; mustAvoid: string | null; sources: string[]; status: string;
    origin: string; dueDate: string | null; rounds: number; artDirection: unknown; generationNote: string | null;
    createdAt: string; roundCredits: number; waitingOn: string | null;
    /** How many pictures the brief is for (a campaign's 10 posts → 10), and its round ceiling. */
    picturesNeeded: number; maxRounds: number;
    /** The social draft this brief is finding a picture for (Phase 5), or null. */
    scheduledPostId: number | null;
    /** A flyer's paper and words (null for every other purpose). */
    paperSize: string | null;
    flyerContent: unknown;
    /** The campaign that commissioned this brief (Phase 3), or null. Its picture joins that campaign. */
    campaign: { id: number; objective: string } | null;
    /** The assistant that ASKED for it — the Campaign Assistant, or the assistant whose post needs the
     *  picture — for the card's "Requested by" pill (src/utils/requested-by.ts). Null when the owner did. */
    requestedBy: string | null;
    options: Array<{
        id: number; round: number; source: string; status: string; url: string | null; width: number | null; height: number | null; mimeType: string | null;
        prompt: string | null; attributionName: string | null; attributionUrl: string | null; rejectReason: string | null; contentAssetId: number | null;
        /** A flyer page: its layout and whether its photo prints soft. */
        flyer: { layout: string; paperSize: string; lowResPhoto: boolean; photoDpi: number | null } | null;
        /** The option's design in a few words, once it has been opened in the studio. For the chat. */
        design: string | null;
    }>;
}

/** This assistant's briefs, newest first, with display URLs (R2 is private — signed, short-lived). */
export async function listBriefs(db: Db, orgId: number, assistantId: number, limit = 100): Promise<BriefView[]> {
    const briefs = await db.select().from(visualBriefs)
        .where(and(eq(visualBriefs.organisationId, orgId), eq(visualBriefs.aiAssistantId, assistantId)))
        .orderBy(desc(visualBriefs.createdAt)).limit(limit);
    if (!briefs.length) return [];
    const campaignIds = [...new Set(briefs.map((b) => b.campaignId).filter((x): x is number => !!x))];
    const objectives = new Map<number, string>();
    // Who asked: the Campaign Assistant that runs the campaign, or the assistant whose post this
    // picture is for. Current names, so a rename shows through.
    const campaignRequester = new Map<number, string>();
    if (campaignIds.length) {
        const rows = await db.select({ id: campaigns.id, objective: campaigns.objective, assistantName: aiAssistants.name }).from(campaigns)
            .leftJoin(aiAssistants, eq(aiAssistants.id, campaigns.aiAssistantId))
            .where(and(eq(campaigns.organisationId, orgId), inArray(campaigns.id, campaignIds)));
        for (const c of rows) {
            objectives.set(c.id, c.objective);
            if (c.assistantName) campaignRequester.set(c.id, c.assistantName);
        }
    }
    const postIds = [...new Set(briefs.map((b) => b.scheduledPostId).filter((x): x is number => !!x))];
    const postRequester = new Map<number, string>();
    if (postIds.length) {
        const rows = await db.select({ id: scheduledPosts.id, assistantName: aiAssistants.name }).from(scheduledPosts)
            .innerJoin(aiAssistants, eq(aiAssistants.id, scheduledPosts.assistantId))
            .where(and(eq(scheduledPosts.organisationId, orgId), inArray(scheduledPosts.id, postIds)));
        for (const r of rows) if (r.assistantName) postRequester.set(r.id, r.assistantName);
    }
    const opts = await db.select().from(visualBriefOptions)
        .where(and(eq(visualBriefOptions.organisationId, orgId), inArray(visualBriefOptions.briefId, briefs.map((b) => b.id))))
        .orderBy(desc(visualBriefOptions.round), visualBriefOptions.id);
    // "Your own" options show the library asset itself — the option row holds no file of its own.
    const ownIds = opts.filter((o) => o.source === OWN_SOURCE && o.contentAssetId).map((o) => o.contentAssetId!);
    const ownUrls = new Map<number, string | null>();
    if (ownIds.length) {
        const assets = await db.select({
            id: contentAssets.id, assetType: contentAssets.assetType, storageUrl: contentAssets.storageUrl,
            storageKey: contentAssets.storageKey, externalUrl: contentAssets.externalUrl,
        }).from(contentAssets).where(and(eq(contentAssets.organisationId, orgId), inArray(contentAssets.id, ownIds)));
        for (const a of assets) ownUrls.set(a.id, await resolveAssetDisplayUrl(a));
    }
    const byBrief = new Map<number, BriefView['options']>();
    for (const o of opts) {
        // A rejected generated option's file was deleted — no URL to sign. Its row stays for the record.
        const gone = o.status === 'rejected' && GENERATED_SOURCES.has(o.source);
        const isVideo = (o.mimeType || '').startsWith('video/');
        const url = gone ? null : o.source === OWN_SOURCE ? ownUrls.get(o.contentAssetId ?? -1) ?? null
            : await resolveAssetDisplayUrl({ assetType: isVideo ? 'video' : 'image', storageKey: previewKeyOf(o.renderParams) ?? o.storageKey, externalUrl: o.externalUrl });
        const list = byBrief.get(o.briefId) ?? [];
        list.push({
            id: o.id, round: o.round, source: o.source, status: o.status, url, width: o.width, height: o.height, mimeType: o.mimeType, prompt: o.prompt,
            attributionName: o.attributionName, attributionUrl: o.attributionUrl, rejectReason: o.rejectReason, contentAssetId: o.contentAssetId,
            design: designOf(o.renderParams) ? designForChat(designOf(o.renderParams)!) : null,
            flyer: o.source === FLYER_SOURCE && o.renderParams
                ? (({ layout, paperSize, lowResPhoto, photoDpi }: FlyerRenderParams) => ({ layout, paperSize, lowResPhoto: !!lowResPhoto, photoDpi: photoDpi ?? null }))(o.renderParams as FlyerRenderParams)
                : null,
        });
        byBrief.set(o.briefId, list);
    }
    return briefs.map((b) => {
        const sources = Array.isArray(b.sources) ? (b.sources as string[]) : [];
        return {
            id: b.id, title: b.title, purpose: b.purpose, aspectRatio: b.aspectRatio, message: b.message, headline: b.headline,
            mood: b.mood, mustInclude: b.mustInclude, mustAvoid: b.mustAvoid, sources, status: b.status, origin: b.origin,
            dueDate: b.dueDate ? String(b.dueDate) : null, rounds: b.rounds, artDirection: b.artDirection, generationNote: b.generationNote,
            createdAt: new Date(b.createdAt).toISOString(),
            picturesNeeded: Number(b.picturesNeeded) || 1,
            maxRounds: maxRoundsFor(b),
            roundCredits: (sources.includes('ai_image') ? IMAGE_CREDIT_COST : 0) + (sources.includes('ai_video') ? VIDEO_CREDIT_COST : 0),
            waitingOn: b.waitingOn,
            scheduledPostId: b.scheduledPostId,
            paperSize: b.paperSize,
            flyerContent: b.flyerContent,
            campaign: b.campaignId && objectives.has(b.campaignId) ? { id: b.campaignId, objective: objectives.get(b.campaignId)! } : null,
            requestedBy: (b.campaignId ? campaignRequester.get(b.campaignId) : undefined)
                ?? (b.scheduledPostId ? postRequester.get(b.scheduledPostId) : undefined) ?? null,
            options: byBrief.get(b.id) ?? [],
        };
    });
}

const previewKeyOf = (p: unknown) => (p && typeof p === 'object' ? (p as { previewKey?: string }).previewKey ?? null : null);
const designOf = (p: unknown) => (p && typeof p === 'object' ? (p as { design?: Design }).design ?? null : null);

/** A flyer's saved words for the chat, so a new version can carry them all, not only the headline. */
function flyerWordsForChat(content: unknown): string {
    const c = (content ?? {}) as { headline?: string; subheading?: string; points?: string[]; callToAction?: string; dateLine?: string };
    return [
        c.headline ? `headline "${clip(c.headline, 80)}"` : '',
        c.subheading ? `subheading "${clip(c.subheading, 140)}"` : '',
        Array.isArray(c.points) && c.points.length ? `points ${c.points.map((p) => `"${clip(p, 80)}"`).join(', ')}` : '',
        c.callToAction ? `call to action "${clip(c.callToAction, 80)}"` : '',
        c.dateLine ? `date line "${clip(c.dateLine, 80)}"` : '',
    ].filter(Boolean).join(', ') || 'no words saved yet';
}

/**
 * What the chat sees each turn: open briefs with every option awaiting a decision, BY ID, so "approve
 * the second AI one" can be turned into a card naming a real option — and nothing else can.
 */
export async function buildBriefsSnapshot(db: Db, orgId: number, assistantId: number): Promise<string> {
    const briefs = (await listBriefs(db, orgId, assistantId, 15)).filter((b) => b.status !== 'cancelled');
    let credits = '';
    try { credits = `AI credits left this month: ${(await getBalance(db, orgId)).balance}.`; } catch { /* unknown is said as unknown */ }
    // The workspace's picture guidelines, verbatim, so a change the user asks for in chat is written
    // as the WHOLE new text (the card replaces a field, it does not append to it).
    let guide = 'PICTURE GUIDELINES: could not be read this turn — do not propose a change to them.';
    try {
        const g = await readBrandGuidelines(db, orgId);
        guide = hasGuidelines(g)
            ? `PICTURE GUIDELINES (current, workspace-wide):\n${guidelinesPromptLines(g).map((l) => `- ${l}`).join('\n')}`
            : 'PICTURE GUIDELINES: none set yet.';
    } catch { /* stated above */ }
    // The colours and font, so the chat can talk them through and write a change. An unset kit is said to be
    // unset: its black and white is only our default, and the user must not be told it is their brand.
    let style = 'BRAND STYLE: could not be read this turn. Do not propose a change to it.';
    try {
        const [org] = await db.select({ kit: organisations.brandKit }).from(organisations).where(eq(organisations.id, orgId)).limit(1);
        const kit = normalizeBrandKit(org?.kit);
        const font = kit.fontFamily ? `font ${kit.fontFamily}` : 'our standard font';
        style = kit.source === 'default'
            ? `BRAND STYLE: no brand colours chosen yet, so designs use our black and white default; ${font}.`
            : `BRAND STYLE (current, ${kit.source === 'manual' ? 'set by them' : 'read from their website'}): main colour ${colourWords(kit.primaryColor)} (${kit.primaryColor}), background ${colourWords(kit.backgroundColor)} (${kit.backgroundColor}), text ${colourWords(kit.textColor)} (${kit.textColor}), ${font}.`;
    } catch { /* stated above */ }
    guide = `${style}\n${guide}`;
    const templates = await listDesignTemplates(db, orgId);
    if (templates.length) guide = `${guide}\nSAVED DESIGN TEMPLATES (by name): ${templates.map((t) => `"${t.name}"`).join(', ')}.`;
    if (!briefs.length) return `YOUR BRIEFS: none yet. ${credits}\n${guide}`.trim();
    const lines = briefs.map((b) => {
        const waiting = b.options.filter((o) => o.status === 'proposed');
        const approved = b.options.filter((o) => o.status === 'approved').length;
        const head = `- Brief ${b.id} "${b.title}"${b.campaign ? ` (commissioned by the campaign "${clip(b.campaign.objective, 80)}" — the picture approved joins that campaign)` : ''}${b.scheduledPostId ? ' (raised for a social post with no picture — the picture approved goes onto that post if it still has none)' : ''}${b.purpose === FLYER_PURPOSE ? ` (a printed ${b.paperSize ?? 'A5'} flyer — ${flyerWordsForChat(b.flyerContent)}; approving one makes its print PDFs in My Content)` : ''} — ${b.status === 'generating' ? 'making options now' : b.status.replace('_', ' ')}; ${b.rounds} round${b.rounds === 1 ? '' : 's'}${b.rounds >= maxRoundsFor(b) ? ' (all its rounds are used, so more options take a new brief)' : ''}; ${approved} approved; sources: ${b.sources.join(', ')}${b.dueDate ? `; due ${b.dueDate}` : ''}${b.waitingOn ? `; waiting on ${clip(b.waitingOn, 60)} to add their own` : ''}.`;
        const rows = waiting.map((o, i) => `    • option ${o.id} (#${i + 1} waiting) — ${sourceLabel(o.source).replace(/s$/, '').toLowerCase()}${o.prompt ? `: ${clip(o.prompt, 90)}` : ''}${o.design ? `\n      in the editor: ${clip(o.design, 900)}` : ''}`);
        return [head, ...rows].join('\n');
    });
    return `YOUR BRIEFS (newest first; option ids are the only ones you may name):\n${lines.join('\n')}\n${credits}\n${guide}`.trim();
}
