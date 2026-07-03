// netlify/functions/autonomous-media-suggestions.ts
// Epic 2 US5: daily cron — for each assistant with autonomous media suggestions enabled, find an
// empty slot in the upcoming schedule and draft a complete post (AI copy + AI image) into the AI
// review queue (status='pending_approval', isAutonomous=true). NEVER auto-published (AC: human
// approval required). Respects the per-assistant monthly autonomous credit cap (AC: threshold
// protection) — credits are held/settled exactly like manual generation.
//
// Schedule: "0 7 * * *" (07:00 UTC daily), after draft-horizon-fill (06:00). Also POSTable for tests.

import { Handler } from '@netlify/functions';
import { and, eq, gte, lte, sql, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import {
    aiAssistants, masterAssistants, scheduledPosts, scheduledPostAssets,
    mediaGenerationJobs, notifications, organisations,
} from '../../db/schema';
import { gatewayGenerate } from '../../src/lib/ai-gateway';
import { generateAndPersistImage } from '../../src/lib/media-persist';
import { holdAutonomousCredits, settleHold, IMAGE_CREDIT_COST } from '../../src/utils/ai-credits';
import { FalContentPolicyError } from '../../src/lib/fal-gateway';
import { resolveMediaForPost } from '../../src/utils/media-resolver';
import { recordPostedAssets } from '../../src/utils/pexels';
import { SMM_ROLE_KEYS } from '../../src/constants/roles';

const PLATFORM = 'instagram';        // only Instagram has a live publisher today
const ASPECT = '4:5' as const;       // Instagram feed-friendly
const IMAGE_MODEL = process.env.FAL_IMAGE_MODEL ?? 'fal-ai/flux-pro/v1.1';

interface DraftCopy { caption: string; hashtags: string; imagePrompt: string; }

// Ask the LLM for caption + hashtags + a visual prompt in one call.
async function draftCopy(orgName: string, assistantName: string): Promise<DraftCopy> {
    const system = `You are ${assistantName}, the social media manager for "${orgName}". Write one engaging, on-brand Instagram post. Respond ONLY with minified JSON: {"caption": string, "hashtags": string (space-separated, 3-6 tags), "imagePrompt": string (a vivid photographic description for an AI image generator, no text/words in image)}.`;
    const res = await gatewayGenerate({
        system,
        messages: [{ role: 'user', content: 'Draft a post for an upcoming empty slot in the content calendar.' }],
        maxTokens: 600,
    });
    try {
        const parsed = JSON.parse(res.text.trim().replace(/^```json\s*|\s*```$/g, ''));
        return {
            caption: String(parsed.caption || '').slice(0, 2000),
            hashtags: String(parsed.hashtags || '').slice(0, 500),
            imagePrompt: String(parsed.imagePrompt || parsed.caption || '').slice(0, 1000),
        };
    } catch {
        // Model didn't return clean JSON — fall back to using the raw text as the caption.
        return { caption: res.text.slice(0, 2000), hashtags: '', imagePrompt: res.text.slice(0, 300) };
    }
}

// First uncovered day (tomorrow..horizon) for the platform, or null if fully covered.
function firstGapDay(coveredDates: Set<string>, horizonDays: number, now: Date): Date | null {
    for (let i = 1; i <= horizonDays; i++) {
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + i, 10, 0, 0));
        if (!coveredDates.has(d.toISOString().slice(0, 10))) return d;
    }
    return null;
}

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST' && !(event as any).schedule) {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }
    const db = getDb();
    const now = new Date();

    const assistants = await db
        .select({
            id: aiAssistants.id,
            userId: aiAssistants.userId,
            organisationId: aiAssistants.organisationId,
            name: aiAssistants.name,
            horizonDays: aiAssistants.draftHorizonDays,
            cap: aiAssistants.autonomousMediaMonthlyCap,
            mediaSources: aiAssistants.mediaSources,
            orgName: organisations.name,
        })
        .from(aiAssistants)
        .innerJoin(masterAssistants, eq(aiAssistants.masterAssistantId, masterAssistants.id))
        .leftJoin(organisations, eq(aiAssistants.organisationId, organisations.id))
        .where(and(
            eq(aiAssistants.isActive, true),
            eq(aiAssistants.autonomousMediaEnabled, true),
            inArray(masterAssistants.roleKey, SMM_ROLE_KEYS),
        ));

    let drafted = 0, skippedNoGap = 0, failed = 0, exhausted = 0;
    const draftedByUser = new Map<number, number>();     // US8: aggregate for one summary notification per user
    const exhaustedByUser = new Map<number, number>();   // AC2.3: assistants that couldn't source any media

    for (const a of assistants) {
        const horizonDays = a.horizonDays ?? 7;
        const windowEnd = new Date(now.getTime() + horizonDays * 24 * 60 * 60 * 1000);

        // Which upcoming days already have a planned post for this assistant?
        const coveredRows = await db
            .select({ publishDate: scheduledPosts.publishDate })
            .from(scheduledPosts)
            .where(and(
                eq(scheduledPosts.assistantId, a.id),
                gte(scheduledPosts.publishDate, now),
                lte(scheduledPosts.publishDate, windowEnd),
                sql`status IN ('draft','in_review','approved','scheduled','pending_approval')`,
            ));
        const covered = new Set(coveredRows.map(r => new Date(r.publishDate).toISOString().slice(0, 10)));

        const gapDay = firstGapDay(covered, horizonDays, now);
        if (!gapDay) { skippedNoGap++; continue; }

        const copy = await draftCopy(a.orgName || 'our brand', a.name);

        // AI generation source — encapsulates the autonomous credit hold/settle + the generation-job
        // ledger, so the resolver only pays for AI when it actually reaches that source. A reached cap
        // throws → the resolver treats AI as unavailable and falls through (or reports exhausted).
        const generateAi = async (): Promise<number> => {
            const hold = await holdAutonomousCredits(db, { orgId: a.organisationId, amount: IMAGE_CREDIT_COST, monthlyCap: a.cap ?? 20 });
            if (!hold.ok) throw new Error('autonomous_cap_reached');

            const [job] = await db.insert(mediaGenerationJobs).values({
                organisationId: a.organisationId, userId: a.userId, assistantId: a.id,
                mediaType: 'image', prompt: copy.imagePrompt, aspectRatio: ASPECT,
                model: IMAGE_MODEL, creditCost: IMAGE_CREDIT_COST, isAutonomous: true, status: 'processing',
            }).returning({ id: mediaGenerationJobs.id });

            try {
                const assetId = await generateAndPersistImage(db, {
                    orgId: a.organisationId, userId: a.userId,
                    prompt: copy.imagePrompt, aspectRatio: ASPECT, generationJobId: job.id,
                });
                await settleHold(db, { orgId: a.organisationId, amount: IMAGE_CREDIT_COST, success: true, mediaType: 'image', userId: a.userId, jobId: job.id, isAutonomous: true });
                await db.update(mediaGenerationJobs).set({ status: 'completed', resultAssetIds: [assetId], updatedAt: new Date() }).where(eq(mediaGenerationJobs.id, job.id));
                return assetId;
            } catch (err) {
                await settleHold(db, { orgId: a.organisationId, amount: IMAGE_CREDIT_COST, success: false, mediaType: 'image', userId: a.userId, isAutonomous: true });
                const flagged = err instanceof FalContentPolicyError;
                await db.update(mediaGenerationJobs)
                    .set({ status: flagged ? 'flagged' : 'failed', errorMessage: err instanceof Error ? err.message : 'generation failed', updatedAt: new Date() })
                    .where(eq(mediaGenerationJobs.id, job.id));
                throw err;
            }
        };

        // Walk the assistant's media-source priority matrix (manual → stock → ai) with fallback.
        let resolved;
        try {
            resolved = await resolveMediaForPost(db, {
                assistant: { mediaSources: a.mediaSources },
                orgId: a.organisationId, userId: a.userId,
                context: copy.imagePrompt || copy.caption,
                mediaType: 'image',
                generateAi,
            });
        } catch (err) {
            console.error('[autonomous-media] resolver error:', err);
            failed++;
            continue;
        }

        if (!resolved.ok) {
            // AC2.3: every enabled source came back empty — notify the user instead of drafting.
            exhaustedByUser.set(a.userId, (exhaustedByUser.get(a.userId) || 0) + 1);
            exhausted++;
            continue;
        }

        const assetId = resolved.assetId;
        const dateLabel = gapDay.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
        const sourceLabel = resolved.source === 'manual' ? 'your content library'
            : resolved.source === 'stock' ? 'a Pexels stock photo' : 'an AI-generated image';

        const [post] = await db.insert(scheduledPosts).values({
            userId: a.userId, organisationId: a.organisationId, assistantId: a.id,
            platform: PLATFORM, postFormat: 'image', publishDate: gapDay,
            caption: copy.caption, hashtags: copy.hashtags || null,
            contentAssetIds: [assetId],
            status: 'pending_approval', isAutonomous: true, triggerType: 'scheduled',
            ownerLabel: `AI: ${a.name}`,
            generationReason: `Drafted to fill an empty ${PLATFORM} slot on ${dateLabel} (media from ${sourceLabel}).`,
            generatedAt: new Date(),
        }).returning({ id: scheduledPosts.id });

        await db.insert(scheduledPostAssets).values({ scheduledPostId: post.id, contentAssetId: assetId, position: 0 }).onConflictDoNothing();

        // Reserve a stock pick in the dedup ledger so the same Pexels asset can't be drafted twice.
        if (resolved.source === 'stock') {
            await recordPostedAssets(db, { orgId: a.organisationId, userId: a.userId, scheduledPostId: post.id }).catch(() => {});
        }

        draftedByUser.set(a.userId, (draftedByUser.get(a.userId) || 0) + 1);
        drafted++;
    }

    // US8 in-app alert: one summary notification per user ("drafted N new posts for your review").
    for (const [uid, n] of draftedByUser) {
        await db.insert(notifications).values({
            userId: uid, type: 'ai_review',
            title: 'New AI drafts ready for review',
            message: `Your AI assistant drafted ${n} new post${n === 1 ? '' : 's'} for your review.`,
            metadata: { count: n },
        }).catch(() => {});
    }

    // AC2.3 in-app alert: assistants whose enabled media sources all came back empty.
    for (const [uid, n] of exhaustedByUser) {
        await db.insert(notifications).values({
            userId: uid, type: 'ai_review',
            title: 'Media needed for auto-drafts',
            message: `Your AI assistant couldn't source media for ${n} planned post${n === 1 ? '' : 's'}. Check the assistant's Media Sources settings or add to your content library.`,
            metadata: { count: n, reason: 'media_exhausted' },
        }).catch(() => {});
    }

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ran: true, assistantsChecked: assistants.length, drafted, skippedNoGap, failed, exhausted }),
    };
};
