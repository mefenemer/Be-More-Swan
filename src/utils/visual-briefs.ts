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
import { aiAssistants, contentAssets, mediaGenerationJobs, organisations, visualBriefOptions, visualBriefs } from '../../db/schema';
import type { getDb } from '../../db/client';
import { gatewayGenerate } from '../lib/ai-gateway';
import { FalContentPolicyError, FalError, falConfigured, generateImages, type AspectRatio } from '../lib/fal-gateway';
import { renderBrandCard, type CardVariant } from '../lib/brand-card';
import { deleteR2Object, persistBufferToR2, persistRemoteMediaToR2, r2IsConfigured } from '../lib/media-persist';
import { normalizeBrandKit, type BrandKit } from './brand-kit';
import { guidelinesPromptLines, hasGuidelines, normaliseGuidelines, readBrandGuidelines, type BrandGuidelines } from './brand-guidelines';
import { holdCredits, settleHold, getBalance, IMAGE_CREDIT_COST } from './ai-credits';
import { orgHasAssistantFeature } from './assistant-capabilities';
import { PexelsRateLimitError, searchUniqueImages } from './pexels';
import { BRAND_CARD_PROVIDER } from './brand-card-lifecycle';
import { resolveAssetDisplayUrl } from './social-publish';
import {
    GENERATION_TIMEOUT_MS, MAX_ROUNDS, PURPOSE_SPECS, REJECT_REASON_LABELS, SOURCE_SPECS,
    type BriefPurpose, type RejectReason,
} from '../config/visual-brief-vocab';

type Db = ReturnType<typeof getDb>;
export type BriefRow = typeof visualBriefs.$inferSelect;
type OptionInsert = typeof visualBriefOptions.$inferInsert;

const IMAGE_MODEL = process.env.FAL_IMAGE_MODEL ?? 'fal-ai/flux-pro/v1.1';
const AI_OPTIONS = SOURCE_SPECS.ai_image.optionsPerRound;
const STOCK_OPTIONS = SOURCE_SPECS.stock.optionsPerRound;
const CARD_VARIANTS: CardVariant[] = ['light', 'bold'];

// ── Art direction ───────────────────────────────────────────────────────────────────────────────

export interface BriefContext {
    kit: BrandKit; orgName: string; industry: string | null; description: string | null;
    /**
     * The workspace's picture guidelines (src/utils/brand-guidelines.ts) — the same ones every
     * automatic AI image reads. Phase 1 asked the Brand Designer's own setup for a photo style and a
     * "never show"; those answers still fill a guideline the workspace has left EMPTY, so nobody who
     * answered them loses the steer when Phase 2 lands.
     */
    guidelines: BrandGuidelines;
}

/** One setup answer, as a trimmed string or null. A plain lookup — the keys match the schema. */
export function setupAnswer(onboardingContext: unknown, key: string): string | null {
    const v = onboardingContext && typeof onboardingContext === 'object' ? (onboardingContext as Record<string, unknown>)[key] : null;
    return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** The new-brief default for sources, from setup. 'free_only' never ticks AI by default. */
export function defaultSourcesFor(onboardingContext: unknown): string[] {
    return setupAnswer(onboardingContext, 'defaultSources') === 'free_only' ? ['stock', 'brand_card'] : ['stock', 'ai_image', 'brand_card'];
}

export interface ArtDirection {
    /** What FLUX is asked for. Never contains words to render — words belong on cards. */
    imagePrompt: string;
    /** 2–4 words for the Pexels search. */
    stockKeywords: string;
    /** Up to two headlines for branded cards — the brief's own words come first. */
    cardHeadlines: string[];
    /** 'model' when Claude wrote it; 'fallback' when it could not and the brief was used as-is. */
    by: 'model' | 'fallback';
}

export interface PastRejection { source: string; reason: string; note: string | null; prompt: string | null }

export async function readBriefContext(db: Db, orgId: number, assistantId: number): Promise<BriefContext> {
    const [[org], [assistant]] = await Promise.all([
        db.select({
            name: organisations.name, industry: organisations.industry,
            description: organisations.businessDescription, brandKit: organisations.brandKit,
            guidelines: organisations.brandGuidelines,
        }).from(organisations).where(eq(organisations.id, orgId)).limit(1),
        db.select({ onboardingContext: aiAssistants.onboardingContext }).from(aiAssistants)
            .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, orgId))).limit(1),
    ]);
    return {
        kit: normalizeBrandKit(org?.brandKit),
        orgName: org?.name ?? '',
        industry: org?.industry ?? null,
        description: org?.description ?? null,
        guidelines: withSetupFallback(normaliseGuidelines(org?.guidelines), assistant?.onboardingContext),
    };
}

/** Phase 1 setup answers fill only the guidelines the workspace left empty — never override one. */
export function withSetupFallback(g: BrandGuidelines, onboardingContext: unknown): BrandGuidelines {
    return {
        ...g,
        photoStyle: g.photoStyle ?? setupAnswer(onboardingContext, 'photoStyle'),
        mustAvoid: g.mustAvoid ?? setupAnswer(onboardingContext, 'avoidAlways'),
    };
}

function clip(s: string | null | undefined, n: number): string {
    return (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
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
        `Colour accents close to ${kit.primaryColor}.`,
        'Photographic, natural light, no text, no lettering, no logos.',
    ].filter(Boolean).join(' ');
    return {
        imagePrompt: imagePrompt.slice(0, 1000),
        stockKeywords: clip(brief.message, 80) || clip(brief.title, 80),
        cardHeadlines: [clip(brief.headline, 120) || clip(brief.message, 120) || clip(brief.title, 120)].filter(Boolean),
        by: 'fallback',
    };
}

export function artDirectionSystemPrompt(): string {
    return `You are a brand designer's art director. From a visual brief and a brand kit you write three things, and nothing else:

1. "imagePrompt" — a prompt for an AI image model (FLUX). One paragraph, under 900 characters. Describe the scene, subject, composition, lighting and mood concretely. Steer colour towards the brand colours given. NEVER ask for words, letters, signs, captions or logos in the image — image models render text badly, and the words go on branded cards instead. Never name a real person or a trademark.
2. "stockKeywords" — 2 to 4 plain words to search a stock photo library (Pexels). Visual nouns, no adjectives about quality, no punctuation.
3. "cardHeadlines" — one or two short headlines (max 90 characters each) for a typographic card in the brand's colours. If the brief gives exact words, the FIRST headline is those words unchanged. Never invent a price, a statistic, a date or an offer the brief does not state.

Respect every "must avoid" in the brief in all three. When earlier options were turned down, the reasons are listed: change what the reason names, keep what it does not.

Return STRICT JSON only: {"imagePrompt": "...", "stockKeywords": "...", "cardHeadlines": ["..."]}`;
}

export function artDirectionUserPrompt(brief: BriefRow, ctx: BriefContext, rejections: PastRejection[]): string {
    const purpose = PURPOSE_SPECS[brief.purpose as BriefPurpose]?.label ?? brief.purpose;
    return [
        `BUSINESS: ${clip(ctx.orgName, 120)}${ctx.industry ? ` (${clip(ctx.industry, 80)})` : ''}`,
        ctx.description ? `ABOUT THEM: ${clip(ctx.description, 400)}` : '',
        `BRAND COLOURS: accent ${ctx.kit.primaryColor}, ink ${ctx.kit.textColor}, background ${ctx.kit.backgroundColor}.`,
        ...guidelinesPromptLines(ctx.guidelines),
        `BRIEF: "${clip(brief.title, 120)}" — a ${purpose.toLowerCase()} in ${brief.aspectRatio}.`,
        brief.message ? `WHAT IT SHOULD SHOW OR SAY: ${clip(brief.message, 1000)}` : '',
        brief.headline ? `EXACT WORDS FOR THE CARD: ${clip(brief.headline, 120)}` : '',
        brief.mood ? `MOOD: ${clip(brief.mood, 300)}` : '',
        brief.mustInclude ? `MUST INCLUDE: ${clip(brief.mustInclude, 500)}` : '',
        brief.mustAvoid ? `MUST AVOID: ${clip(brief.mustAvoid, 500)}` : '',
        rejections.length
            ? `TURNED DOWN EARLIER:\n${rejections.slice(-8).map((r) => `- a ${SOURCE_SPECS[r.source as keyof typeof SOURCE_SPECS]?.label.toLowerCase() ?? r.source} option: ${r.reason}${r.note ? ` — "${clip(r.note, 200)}"` : ''}${r.prompt ? ` (it was made from: ${clip(r.prompt, 160)})` : ''}`).join('\n')}`
            : '',
    ].filter(Boolean).join('\n');
}

/** Parse the model's JSON; any field it got wrong falls back to the brief's own words. */
export function parseArtDirection(raw: string, fallback: ArtDirection, exactHeadline: string | null): ArtDirection {
    let j: Record<string, unknown> = {};
    try {
        const m = raw.match(/\{[\s\S]*\}/);
        j = m ? JSON.parse(m[0]) : {};
    } catch { return fallback; }
    const imagePrompt = clip(typeof j.imagePrompt === 'string' ? j.imagePrompt : '', 1000);
    const stockKeywords = clip(typeof j.stockKeywords === 'string' ? j.stockKeywords.replace(/[^\p{L}\p{N}\s-]/gu, ' ') : '', 80);
    let heads = Array.isArray(j.cardHeadlines) ? j.cardHeadlines.filter((h): h is string => typeof h === 'string').map((h) => clip(h, 120)).filter(Boolean) : [];
    // The user's exact words are never paraphrased away, whatever the model returned.
    if (exactHeadline) heads = [clip(exactHeadline, 120), ...heads.filter((h) => h !== clip(exactHeadline, 120))];
    if (!imagePrompt && !stockKeywords && !heads.length) return fallback;
    return {
        imagePrompt: imagePrompt || fallback.imagePrompt,
        stockKeywords: stockKeywords || fallback.stockKeywords,
        cardHeadlines: (heads.length ? heads : fallback.cardHeadlines).slice(0, CARD_VARIANTS.length),
        by: 'model',
    };
}

export async function writeArtDirection(brief: BriefRow, ctx: BriefContext, rejections: PastRejection[]): Promise<ArtDirection> {
    const fallback = fallbackArtDirection(brief, ctx.kit, ctx.guidelines);
    try {
        const res = await gatewayGenerate({
            system: artDirectionSystemPrompt(),
            messages: [{ role: 'user', content: artDirectionUserPrompt(brief, ctx, rejections) }],
            maxTokens: 700,
            deadlineMs: 45_000,
            usage: { workspaceId: brief.organisationId, assistantId: brief.aiAssistantId },
        });
        return parseArtDirection(res.text, fallback, brief.headline);
    } catch (err) {
        console.error('[visual-briefs] art direction failed — using the brief as written:', err instanceof Error ? err.message : err);
        return fallback;
    }
}

// ── Starting and ending a round ─────────────────────────────────────────────────────────────────

export type StartRoundResult =
    | { ok: true; round: number; aiIncluded: boolean; credits: number }
    | { ok: false; status: number; error: string; code?: string; cost?: number; balance?: number };

/**
 * The click. Holds the round's credit, marks the brief generating, and returns; the caller wakes
 * the worker. AI is silently NOT included when the workspace cannot use it (the note says so), so a
 * brief with stock and cards still produces something rather than refusing outright.
 */
export async function startRound(db: Db, args: { orgId: number; brief: BriefRow }): Promise<StartRoundResult> {
    const { orgId, brief } = args;
    if (brief.status === 'generating') return { ok: false, status: 409, error: 'Options are already being made for this brief.' };
    if (brief.status === 'cancelled') return { ok: false, status: 409, error: 'This brief was cancelled.' };
    if (brief.rounds >= MAX_ROUNDS) {
        return { ok: false, status: 409, error: `This brief has had ${MAX_ROUNDS} rounds. If none of them fit, the brief probably needs changing — start a new one.` };
    }

    const sources = Array.isArray(brief.sources) ? (brief.sources as string[]) : [];
    let note: string | null = null;
    let aiIncluded = sources.includes('ai_image');
    if (aiIncluded && !(await orgHasAssistantFeature(db, orgId, 'ai_image_generation'))) {
        aiIncluded = false;
        note = 'AI images are not switched on for this workspace, so this round has stock photos and branded cards only.';
    }
    if (!aiIncluded && !sources.some((s) => s === 'stock' || s === 'brand_card')) {
        return { ok: false, status: 403, error: 'AI images are not switched on for this workspace, and this brief asks for nothing else. Edit it to include stock photos or branded cards.', code: 'feature_unavailable' };
    }

    const credits = aiIncluded ? IMAGE_CREDIT_COST : 0;
    if (credits > 0) {
        const hold = await holdCredits(db, { orgId, amount: credits });
        if (!hold.ok) return { ok: false, status: 402, error: 'insufficient_credits', code: 'insufficient_credits', cost: credits, balance: hold.balance };
    }

    const rows = await db.update(visualBriefs).set({
        status: 'generating',
        rounds: sql`${visualBriefs.rounds} + 1`,
        creditHold: credits,
        generationStartedAt: new Date(),
        generationNote: note,
        updatedAt: new Date(),
    }).where(and(
        eq(visualBriefs.id, brief.id),
        eq(visualBriefs.organisationId, orgId),
        sql`${visualBriefs.status} NOT IN ('generating', 'cancelled')`,
        sql`${visualBriefs.rounds} < ${MAX_ROUNDS}`,
    )).returning({ rounds: visualBriefs.rounds });

    if (!rows.length) {
        // Someone else started a round between our read and our write. Give the hold back.
        if (credits > 0) await settleHold(db, { orgId, amount: credits, success: false, mediaType: 'image' });
        return { ok: false, status: 409, error: 'Options are already being made for this brief.' };
    }
    return { ok: true, round: rows[0].rounds, aiIncluded, credits };
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
    chargeAi: boolean; note: string | null; artDirection?: ArtDirection | null; userId?: number | null;
}): Promise<boolean> {
    const rows = await db.execute<{ organisation_id: number; held: number }>(sql`
        UPDATE visual_briefs b
           SET status = CASE
                   WHEN EXISTS (SELECT 1 FROM visual_brief_options o WHERE o.brief_id = b.id AND o.status = 'approved') THEN 'approved'
                   WHEN EXISTS (SELECT 1 FROM visual_brief_options o WHERE o.brief_id = b.id AND o.status = 'proposed') THEN 'in_review'
                   ELSE 'open' END,
               credit_hold = 0,
               generation_note = ${outcome.note},
               art_direction = COALESCE(${outcome.artDirection ? JSON.stringify(outcome.artDirection) : null}::jsonb, b.art_direction),
               updated_at = now()
          FROM (SELECT id, credit_hold AS held FROM visual_briefs WHERE id = ${briefId} FOR UPDATE) old
         WHERE b.id = old.id AND b.status = 'generating'
     RETURNING b.organisation_id, old.held`);
    const row = rows[0];
    if (!row) return false;
    const held = Number(row.held) || 0;
    if (held > 0) {
        await settleHold(db, { orgId: row.organisation_id, amount: held, success: outcome.chargeAi, mediaType: 'image', userId: outcome.userId ?? null });
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
        // Stored as "<reason key>" or "<reason key>: <the user's words>".
        const [key, ...rest] = r.reason.split(':');
        rejections.push({
            source: r.source,
            reason: REJECT_REASON_LABELS[key as RejectReason] ?? key,
            note: rest.join(':').trim() || null,
            prompt: r.prompt,
        });
    }
    const shownStockIds = rows.filter((r) => r.source === 'stock' && r.providerAssetId).map((r) => r.providerAssetId!);
    return { rejections, shownStockIds };
}

/** Run one round. Never throws: every exit ends the round, so the credit is always settled. */
export async function runRound(db: Db, briefId: number, userId: number | null): Promise<void> {
    const [brief] = await db.select().from(visualBriefs).where(and(eq(visualBriefs.id, briefId), eq(visualBriefs.status, 'generating'))).limit(1);
    if (!brief) return;

    let aiProduced = false;
    let artDirection: ArtDirection | null = null;
    const notes: string[] = brief.generationNote ? [brief.generationNote] : [];
    try {
        const ctx = await readBriefContext(db, brief.organisationId, brief.aiAssistantId);
        const { rejections, shownStockIds } = await pastRejections(db, brief.id);
        artDirection = await writeArtDirection(brief, ctx, rejections);
        const sources = Array.isArray(brief.sources) ? (brief.sources as string[]) : [];
        const base = { organisationId: brief.organisationId, briefId: brief.id, round: brief.rounds };
        const ad = artDirection;

        const [stock, ai, cards] = await Promise.allSettled([
            sources.includes('stock') ? stockOptions(db, brief, ad, shownStockIds) : Promise.resolve([]),
            sources.includes('ai_image') && brief.creditHold >= IMAGE_CREDIT_COST ? aiOptions(db, brief, ad, userId) : Promise.resolve([]),
            sources.includes('brand_card') ? cardOptions(brief, ad, ctx) : Promise.resolve([]),
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
        aiProduced = ai.status === 'fulfilled' && ai.value.length > 0;

        if (sources.includes('stock') && stock.status === 'fulfilled' && !stock.value.length) {
            notes.push('No new stock photos matched — the search words are shown under the brief.');
        }
        if (options.length) await db.insert(visualBriefOptions).values(options);
    } catch (err) {
        console.error('[visual-briefs] round failed:', briefId, err instanceof Error ? err.message : err);
        notes.push('Something went wrong making options. Nothing was charged for anything that was not made — try again.');
    } finally {
        await endRound(db, briefId, { chargeAi: aiProduced, note: notes.length ? notes.join(' ') : null, artDirection, userId });
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
 * Four FLUX variations for one credit, each copied into R2 at once — fal's URLs expire within
 * hours and a brief can sit in review for days. Every attempt writes a media_generation_jobs row, so
 * the platform-wide failure alert (check-provider-balances) sees this path like every other.
 */
async function aiOptions(db: Db, brief: BriefRow, ad: ArtDirection, userId: number | null) {
    const aspectRatio = brief.aspectRatio as AspectRatio;
    const job = {
        organisationId: brief.organisationId, userId, assistantId: brief.aiAssistantId, mediaType: 'image',
        prompt: ad.imagePrompt, aspectRatio, model: IMAGE_MODEL, creditCost: IMAGE_CREDIT_COST,
    };
    let images;
    try {
        images = falConfigured()
            ? await generateImages({ prompt: ad.imagePrompt, aspectRatio, numImages: AI_OPTIONS })
            : Array.from({ length: AI_OPTIONS }, (_, i) => ({ url: `https://picsum.photos/seed/brief-${brief.id}-${brief.rounds}-${i}/1024/1024`, width: 1024, height: 1024, contentType: 'image/jpeg' }));
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
        out.push({ source: 'ai_image', storageKey, externalUrl, mimeType, width: img.width || null, height: img.height || null, prompt: ad.imagePrompt });
    }
    await db.insert(mediaGenerationJobs).values({
        ...job, status: out.length ? 'completed' : 'failed',
        errorMessage: out.length ? null : '[brand-designer] generated, but no image could be stored',
        candidates: images.map((i) => ({ url: i.url, width: i.width, height: i.height, contentType: i.contentType })),
    }).catch(() => {});
    return out;
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

/** Recompute a brief's status from its options. Leaves a generating or cancelled brief alone. */
async function settleBriefStatus(db: Db, briefId: number): Promise<void> {
    await db.execute(sql`
        UPDATE visual_briefs b
           SET status = CASE
                   WHEN EXISTS (SELECT 1 FROM visual_brief_options o WHERE o.brief_id = b.id AND o.status = 'approved') THEN 'approved'
                   WHEN EXISTS (SELECT 1 FROM visual_brief_options o WHERE o.brief_id = b.id AND o.status = 'proposed') THEN 'in_review'
                   ELSE 'open' END,
               updated_at = now()
         WHERE b.id = ${briefId} AND b.status NOT IN ('generating', 'cancelled')`);
}

export type DecideResult = { ok: true; contentAssetId?: number } | { ok: false; status: number; error: string };

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
        if (opt.storageKey && opt.source !== 'stock') await deleteR2Object(opt.storageKey);
        await settleBriefStatus(db, brief.id);
        return { ok: true };
    }

    const claimed = await db.update(visualBriefOptions)
        .set({ status: 'approved', decidedAt: new Date() })
        .where(and(eq(visualBriefOptions.id, optionId), eq(visualBriefOptions.status, 'proposed')))
        .returning({ id: visualBriefOptions.id });
    if (!claimed.length) return { ok: false, status: 409, error: 'That option was already decided.' };

    try {
        const name = clip(`${brief.title} — ${SOURCE_SPECS[opt.source as keyof typeof SOURCE_SPECS]?.label.replace(/s$/, '') ?? opt.source}`, 120);
        const common = {
            userId, organisationId: orgId, name, assetType: 'image', mimeType: opt.mimeType,
            width: opt.width, height: opt.height, aspectRatio: brief.aspectRatio, status: 'pending',
        };
        const values = opt.source === 'stock'
            ? { ...common, externalUrl: opt.externalUrl, provider: 'pexels', providerAssetId: opt.providerAssetId, attributionName: opt.attributionName, attributionUrl: opt.attributionUrl }
            : opt.source === 'brand_card'
                // libraryKeptAt: a card a human approved is not transient media — without it the
                // 30-day unused-card sweep (brand-card-lifecycle.ts) would delete it from the library.
                ? { ...common, storageKey: opt.storageKey, externalUrl: opt.externalUrl, provider: BRAND_CARD_PROVIDER, prompt: opt.prompt, renderParams: opt.renderParams, libraryKeptAt: new Date() }
                : { ...common, storageKey: opt.storageKey, externalUrl: opt.externalUrl, provider: 'fal', prompt: opt.prompt };
        const [asset] = await db.insert(contentAssets).values(values).returning({ id: contentAssets.id });
        await db.update(visualBriefOptions).set({ contentAssetId: asset.id }).where(eq(visualBriefOptions.id, optionId));
        await settleBriefStatus(db, brief.id);
        return { ok: true, contentAssetId: asset.id };
    } catch (err) {
        // Give the option back rather than leave it "approved" with nothing in the library.
        await db.update(visualBriefOptions).set({ status: 'proposed', decidedAt: null }).where(eq(visualBriefOptions.id, optionId));
        console.error('[visual-briefs] approve failed:', optionId, err instanceof Error ? err.message : err);
        return { ok: false, status: 500, error: 'Could not add that to your library — please try again.' };
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
    for (const o of leftovers) if (o.key && o.source !== 'stock') await deleteR2Object(o.key);
    if (leftovers.length) {
        await db.update(visualBriefOptions).set({ status: 'rejected', rejectReason: 'other: brief cancelled', decidedAt: new Date() })
            .where(inArray(visualBriefOptions.id, leftovers.map((o) => o.id)));
    }
    return { ok: true };
}

// ── Reading ─────────────────────────────────────────────────────────────────────────────────────

export interface BriefView {
    id: number; title: string; purpose: string; aspectRatio: string; message: string | null; headline: string | null;
    mood: string | null; mustInclude: string | null; mustAvoid: string | null; sources: string[]; status: string;
    origin: string; dueDate: string | null; rounds: number; artDirection: unknown; generationNote: string | null;
    createdAt: string; roundCredits: number;
    options: Array<{
        id: number; round: number; source: string; status: string; url: string | null; width: number | null; height: number | null;
        prompt: string | null; attributionName: string | null; attributionUrl: string | null; rejectReason: string | null; contentAssetId: number | null;
    }>;
}

/** This assistant's briefs, newest first, with display URLs (R2 is private — signed, short-lived). */
export async function listBriefs(db: Db, orgId: number, assistantId: number, limit = 100): Promise<BriefView[]> {
    const briefs = await db.select().from(visualBriefs)
        .where(and(eq(visualBriefs.organisationId, orgId), eq(visualBriefs.aiAssistantId, assistantId)))
        .orderBy(desc(visualBriefs.createdAt)).limit(limit);
    if (!briefs.length) return [];
    const opts = await db.select().from(visualBriefOptions)
        .where(and(eq(visualBriefOptions.organisationId, orgId), inArray(visualBriefOptions.briefId, briefs.map((b) => b.id))))
        .orderBy(desc(visualBriefOptions.round), visualBriefOptions.id);
    const byBrief = new Map<number, BriefView['options']>();
    for (const o of opts) {
        // A rejected AI/card option's picture was deleted — no URL to sign. Its row stays for the record.
        const gone = o.status === 'rejected' && o.source !== 'stock';
        const url = gone ? null : await resolveAssetDisplayUrl({ assetType: 'image', storageKey: o.storageKey, externalUrl: o.externalUrl });
        const list = byBrief.get(o.briefId) ?? [];
        list.push({
            id: o.id, round: o.round, source: o.source, status: o.status, url, width: o.width, height: o.height, prompt: o.prompt,
            attributionName: o.attributionName, attributionUrl: o.attributionUrl, rejectReason: o.rejectReason, contentAssetId: o.contentAssetId,
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
            roundCredits: sources.includes('ai_image') ? IMAGE_CREDIT_COST : 0,
            options: byBrief.get(b.id) ?? [],
        };
    });
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
    if (!briefs.length) return `YOUR BRIEFS: none yet. ${credits}\n${guide}`.trim();
    const lines = briefs.map((b) => {
        const waiting = b.options.filter((o) => o.status === 'proposed');
        const approved = b.options.filter((o) => o.status === 'approved').length;
        const head = `- Brief ${b.id} "${b.title}" — ${b.status === 'generating' ? 'making options now' : b.status.replace('_', ' ')}; ${b.rounds} round${b.rounds === 1 ? '' : 's'}; ${approved} approved; sources: ${b.sources.join(', ')}${b.dueDate ? `; due ${b.dueDate}` : ''}.`;
        const rows = waiting.map((o, i) => `    • option ${o.id} (#${i + 1} waiting) — ${SOURCE_SPECS[o.source as keyof typeof SOURCE_SPECS]?.label.replace(/s$/, '').toLowerCase() ?? o.source}${o.prompt ? `: ${clip(o.prompt, 90)}` : ''}`);
        return [head, ...rows].join('\n');
    });
    return `YOUR BRIEFS (newest first; option ids are the only ones you may name):\n${lines.join('\n')}\n${credits}\n${guide}`.trim();
}
