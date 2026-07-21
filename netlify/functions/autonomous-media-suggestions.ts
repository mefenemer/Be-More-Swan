// netlify/functions/autonomous-media-suggestions.ts
// Epic 2 US5: daily cron — for each assistant with autonomous media suggestions enabled, find an
// empty slot in the upcoming schedule and draft a complete post (AI copy + AI image) into the AI
// review queue (status='pending_approval', isAutonomous=true). Respects the per-assistant monthly
// autonomous credit cap (AC: threshold protection) — credits are held/settled exactly like manual
// generation.
//
// Auto-publish (src/utils/publish-policy.ts): a draft skips the review queue and goes straight to
// status='scheduled' ONLY when the deployer has opted this platform into 'auto_publish' AND the
// confidence scorer rates the caption green with zero factual claims. Both default to review, so
// human approval remains the default for every assistant. This is the only writer permitted to
// skip review — manual and chat drafts always have a human present.
//
// Schedule: "0 7 * * *" (07:00 UTC daily), after draft-horizon-fill (06:00). Also POSTable for tests.

import { Handler } from '@netlify/functions';
import { randomUUID } from 'crypto';
import { and, eq, gte, lte, sql, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import {
    aiAssistants, masterAssistants, scheduledPosts, scheduledPostAssets,
    mediaGenerationJobs, organisations,
} from '../../db/schema';
import { createNotification } from '../../src/utils/notify';
import { gatewayGenerate } from '../../src/lib/ai-gateway';
import { generateAndPersistImage } from '../../src/lib/media-persist';
import { holdAutonomousCredits, settleHold, IMAGE_CREDIT_COST } from '../../src/utils/ai-credits';
import { FalContentPolicyError } from '../../src/lib/fal-gateway';
import { resolveMediaForPost } from '../../src/utils/media-resolver';
import { recordPostedAssets } from '../../src/utils/pexels';
import { SMM_ROLE_KEYS } from '../../src/constants/roles';
import { type AutonomousDraftPlatform } from '../../src/utils/publish-policy';
import { resolveConnectedDraftPlatforms } from '../../src/utils/auto-publish-runtime';
import { platformFormat } from '../../src/config/platform-formats';
import { decideAutoPublish, describeDecision } from '../../src/utils/auto-publish-runtime';
import { withLambda } from '@netlify/aws-lambda-compat';

const IMAGE_MODEL = process.env.FAL_IMAGE_MODEL ?? 'fal-ai/flux-pro/v1.1';

interface DraftCopy { caption: string; hashtags: string; imagePrompt: string; }

// Ask the LLM for caption + hashtags + a visual prompt in one call, tailored to the platform.
async function draftCopy(orgName: string, assistantName: string, platform: AutonomousDraftPlatform): Promise<DraftCopy> {
    const label = platformFormat(platform).label;
    const system = `You are ${assistantName}, the social media manager for "${orgName}". Write one engaging, on-brand ${label} post. Respond ONLY with minified JSON: {"caption": string, "hashtags": string (space-separated, 3-6 tags), "imagePrompt": string (a vivid photographic description for an AI image generator, no text/words in image)}.`;
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

export default withLambda(async (event) => {
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
            onboardingContext: aiAssistants.onboardingContext,
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

    let drafted = 0, autoScheduled = 0, skippedNoGap = 0, failed = 0, exhausted = 0;
    // A scorer that times out or returns junk falls back to amber, which looks exactly like a
    // cautious verdict. Count it separately so a persistently broken scorer is visible in the
    // cron's own output instead of silently routing everything to review forever.
    let scoringUnavailable = 0;
    const draftedByUser = new Map<number, number>();       // US8: aggregate for one summary notification per user
    const autoScheduledByUser = new Map<number, number>(); // auto-publish: skipped review, needs a different message
    const exhaustedByUser = new Map<number, number>();     // AC2.3: assistants that couldn't source any media

    for (const a of assistants) {
        const horizonDays = a.horizonDays ?? 7;
        const windowEnd = new Date(now.getTime() + horizonDays * 24 * 60 * 60 * 1000);

        // One idea per assistant: pick a single empty day, draft ONE caption + ONE image, and fan it
        // across every platform the assistant targets — siblings share a crosspost_group_id so the
        // Review Queue shows one card the human previews per platform (not N per-platform posts).
        // Legacy assistants with no recognised platforms stay Instagram-only.
        const targetPlatforms = await resolveConnectedDraftPlatforms(db, a.organisationId);
        const platforms: AutonomousDraftPlatform[] = targetPlatforms.length ? targetPlatforms : ['instagram'];
        const representative = platforms[0];
        const fmt = platformFormat(representative);

        // Coverage is per day now (one cross-post covers every platform that day): any planned post on
        // a day means that day is already taken.
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

        const copy = await draftCopy(a.orgName || 'our brand', a.name, representative);

        // AI generation source — encapsulates the autonomous credit hold/settle + the generation-job
        // ledger, so the resolver only pays for AI when it actually reaches that source. A reached cap
        // throws → the resolver treats AI as unavailable and falls through (or reports exhausted).
        const generateAi = async (): Promise<number> => {
            const hold = await holdAutonomousCredits(db, { orgId: a.organisationId, amount: IMAGE_CREDIT_COST, monthlyCap: a.cap ?? 20 });
            if (!hold.ok) throw new Error('autonomous_cap_reached');

            const [job] = await db.insert(mediaGenerationJobs).values({
                organisationId: a.organisationId, userId: a.userId, assistantId: a.id,
                mediaType: 'image', prompt: copy.imagePrompt, aspectRatio: fmt.aspectRatio,
                model: IMAGE_MODEL, creditCost: IMAGE_CREDIT_COST, isAutonomous: true, status: 'processing',
            }).returning({ id: mediaGenerationJobs.id });

            try {
                const assetId = await generateAndPersistImage(db, {
                    orgId: a.organisationId, userId: a.userId,
                    prompt: copy.imagePrompt, aspectRatio: fmt.aspectRatio, generationJobId: job.id,
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
        // Siblings of this one idea share the group id (null when there's only one platform).
        const crosspostGroupId = platforms.length > 1 ? randomUUID() : null;

        // Fan the one idea across the platforms. Caption, image and slot are shared; the auto-publish
        // gate is per platform (connection, policy, confidence), so it runs inside the loop.
        let stockReserved = false;
        let anyAwaitingReview = false;
        for (const platform of platforms) {
            // Autopilot publish gate — platform policy, no AI media, green caption, a live connection,
            // and the rolling weekly ceiling. Everything else lands in 'pending_approval'.
            const gate = await decideAutoPublish(db, {
                assistantId: a.id,
                organisationId: a.organisationId,
                platform,
                caption: copy.caption,
                mediaSource: resolved.source,
                onboardingContext: a.onboardingContext,
                now,
            });

            if (gate.reason === 'scoring_unavailable') {
                scoringUnavailable++;
                console.warn(`[autonomous-media] confidence scorer unavailable (${gate.confidence?.failureMode}) for assistant ${a.id} — routed to review.`);
            }
            if (gate.reason === 'weekly_cap_reached') {
                console.warn(`[autonomous-media] assistant ${a.id} hit its weekly auto-publish ceiling — routed to review.`);
            }

            const gateLabel = describeDecision(gate);

            const [post] = await db.insert(scheduledPosts).values({
                userId: a.userId, organisationId: a.organisationId, assistantId: a.id,
                platform, postFormat: 'image', publishDate: gapDay,
                caption: copy.caption, hashtags: copy.hashtags || null,
                contentAssetIds: [assetId],
                connectionId: gate.connectionId,
                status: gate.status, isAutonomous: true, triggerType: 'scheduled',
                // Marks the post unattended and counts toward the rolling weekly ceiling.
                autoPublishedAt: gate.status === 'scheduled' ? new Date() : null,
                ownerLabel: `AI: ${a.name}`,
                generationReason: `Drafted to fill an empty slot on ${dateLabel} (media from ${sourceLabel}). ${gateLabel}`,
                generatedAt: new Date(),
                crosspostGroupId,
                // Persist the scorer's verdict inline — the drafter calls scoreCaption directly, so
                // there's no separate score-post-confidence round-trip to fill these in. Null when the
                // platform is in review mode and scoring was skipped.
                confidenceScore: gate.confidence?.confidenceScore ?? null,
                factualClaimsCount: gate.confidence?.factualClaimsCount ?? null,
                factualClaims: (gate.confidence?.factualClaims ?? null) as any,
                confidenceAssessedAt: gate.confidence ? new Date() : null,
                confidenceAssessmentMs: gate.confidence?.assessmentDurationMs ?? null,
            }).returning({ id: scheduledPosts.id });

            await db.insert(scheduledPostAssets).values({ scheduledPostId: post.id, contentAssetId: assetId, position: 0 }).onConflictDoNothing();

            // Reserve the stock pick once for the group so the same Pexels asset can't be drafted twice.
            if (resolved.source === 'stock' && !stockReserved) {
                await recordPostedAssets(db, { orgId: a.organisationId, userId: a.userId, scheduledPostId: post.id }).catch(() => {});
                stockReserved = true;
            }

            if (gate.status !== 'scheduled') anyAwaitingReview = true;
        }

        // Count one idea (one Review Queue card), not one per platform: it shows in review if any
        // platform awaits approval, else it's an all-scheduled auto-published cross-post.
        if (anyAwaitingReview) {
            draftedByUser.set(a.userId, (draftedByUser.get(a.userId) || 0) + 1);
        } else {
            autoScheduledByUser.set(a.userId, (autoScheduledByUser.get(a.userId) || 0) + 1);
            autoScheduled++;
        }
        drafted++;
    }

    // US8 in-app alert: one summary notification per user ("drafted N new posts for your review").
    for (const [uid, n] of draftedByUser) {
        await createNotification(db, 'ai_review_batch', {
            userId: uid,
            context: { batch: { post_count: `${n} new post${n === 1 ? '' : 's'}` } },
            metadata: { count: n },
        });
    }

    // Auto-publish alert: these skipped the review queue, so tell the user what was scheduled
    // on their behalf rather than asking them to review it.
    for (const [uid, n] of autoScheduledByUser) {
        await createNotification(db, 'ai_auto_publish_batch', {
            userId: uid,
            context: { batch: {
                post_count: `${n} new post${n === 1 ? '' : 's'}`,
                them: n === 1 ? 'it' : 'them',
                they_go: n === 1 ? 'it goes' : 'they go',
            } },
            metadata: { count: n, reason: 'auto_publish' },
        });
    }

    // AC2.3 in-app alert: assistants whose enabled media sources all came back empty.
    for (const [uid, n] of exhaustedByUser) {
        await createNotification(db, 'ai_review_media_needed', {
            userId: uid,
            context: { batch: { post_count: `${n} planned post${n === 1 ? '' : 's'}` } },
            metadata: { count: n, reason: 'media_exhausted' },
        });
    }

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ran: true, assistantsChecked: assistants.length, drafted, autoScheduled, scoringUnavailable, skippedNoGap, failed, exhausted }),
    };
});
