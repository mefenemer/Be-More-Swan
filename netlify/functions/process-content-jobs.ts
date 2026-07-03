// netlify/functions/process-content-jobs.ts
// US-SMM-3.1.1 + US-SMM-3.4.1: Drains the content_generation_jobs queue every minute.
// Uses FOR UPDATE SKIP LOCKED to safely handle concurrent cron ticks.

import { Handler } from '@netlify/functions';
import Anthropic from '@anthropic-ai/sdk';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import {
    contentGenerationJobs, aiBlueprints, aiAssistants,
    scheduledPosts, scheduledPostAssets, contentAssets, mediaGenerationJobs,
    notifications, auditLogs, organisations,
} from '../../db/schema';
import { gatewayGenerate } from '../../src/lib/ai-gateway';
import { AURA_SAFE_CONTENT_BENCHMARK } from '../../src/constants/safety-benchmark';
import { creditLine } from '../../src/utils/pexels';
import { resolveMediaForPost } from '../../src/utils/media-resolver';
import { holdCredits, settleHold, IMAGE_CREDIT_COST } from '../../src/utils/ai-credits';
import { generateAndPersistImage } from '../../src/lib/media-persist';
import { FalContentPolicyError } from '../../src/lib/fal-gateway';
import { DISCLOSURE } from '../../src/config/compliance';
import { fireOrchestrations } from '../../src/utils/orchestration';

// Fal image model for inline AI generation (matches the autonomous suggestions path).
const AI_IMAGE_MODEL = process.env.FAL_IMAGE_MODEL ?? 'fal-ai/flux-pro/v1.1';

const BACKOFF_SECS = [10, 30, 90];

// Core queue drain: reset stuck jobs, claim up to 20 queued jobs, generate each. Returns the
// number of jobs claimed this pass. Extracted from the handler so it can be driven both by the
// native Netlify schedule (this file's `handler`) AND by an on-demand HTTP trigger
// (run-content-jobs.ts) — the latter is how staging/branch deploys drain their queue, since
// Netlify only runs scheduled functions on the production deploy.
export async function drainContentJobs(): Promise<number> {
    const db = getDb();
    const now = new Date();

    // Reset jobs stuck in 'processing' for >3 minutes (function timed out mid-run)
    await db.execute(
        `UPDATE content_generation_jobs SET status = 'queued', next_retry_at = now()
         WHERE status = 'processing' AND updated_at < now() - interval '3 minutes' AND attempt < max_attempts`
    );

    const jobs = await db.execute<{
        id: number; job_id: string; blueprint_id: number; assistant_id: number;
        organisation_id: number; user_id: number; attempt: number; max_attempts: number;
        context_prompt: string | null; trigger_type: string | null; platform: string | null;
        admin_id: number | null; target_publish_date: string | null;
    }>(
        `SELECT id, job_id, blueprint_id, assistant_id, organisation_id, user_id, attempt, max_attempts,
                context_prompt, trigger_type, platform, admin_id, target_publish_date
         FROM content_generation_jobs
         WHERE status = 'queued'
           AND (next_retry_at IS NULL OR next_retry_at <= now())
         ORDER BY created_at
         LIMIT 20
         FOR UPDATE SKIP LOCKED`
    );

    if (!jobs.length) return 0;

    await Promise.allSettled(jobs.map(job => processJob(db, job, now)));

    return jobs.length;
}

export const handler: Handler = async () => {
    const processed = await drainContentJobs();
    return { statusCode: 200, body: processed ? `processed ${processed} jobs` : 'no jobs' };
};

async function processJob(db: ReturnType<typeof getDb>, job: {
    id: number; job_id: string; blueprint_id: number; assistant_id: number;
    organisation_id: number; user_id: number; attempt: number; max_attempts: number;
    context_prompt: string | null; trigger_type: string | null; platform: string | null;
    admin_id: number | null; target_publish_date: string | null;
}, now: Date) {
    await db.execute(
        `UPDATE content_generation_jobs SET status = 'processing', attempt = attempt + 1, updated_at = now() WHERE id = ${job.id}`
    );

    // "Create Post" → Suggest an idea: when a scheduled/conversion job carries no context of its
    // own, fold in the oldest pending user idea for this assistant (FIFO, consumed once). Best-effort
    // — a lookup failure must never fail the generation job. We mutate job.context_prompt so every
    // downstream prompt reference picks it up, and remember the row to mark 'used' after the insert.
    let consumedIdeaId: number | null = null;
    if (!job.context_prompt && (job.trigger_type === 'scheduled' || job.trigger_type === 'conversion')) {
        try {
            const [idea] = await db.execute<{ id: number; idea: string }>(
                `SELECT id, idea FROM post_idea_suggestions
                 WHERE assistant_id = ${job.assistant_id} AND status = 'pending'
                 ORDER BY created_at ASC LIMIT 1`
            );
            if (idea) { job.context_prompt = idea.idea; consumedIdeaId = idea.id; }
        } catch (e) {
            console.warn(`[process-content-jobs] idea lookup skipped for job ${job.job_id}:`, e instanceof Error ? e.message : e);
        }
    }

    try {
        const [bp] = await db
            .select({ sections: aiBlueprints.sections })
            .from(aiBlueprints)
            .where(eq(aiBlueprints.id, job.blueprint_id))
            .limit(1);
        if (!bp) throw new Error('Blueprint not found');

        const sections = bp.sections as Record<string, { content: Record<string, unknown> }>;

        const identity    = sections['1-identity']?.content    || {};
        const compliance  = sections['9-compliance']?.content  || {};
        const onboarding  = sections['5-org-context']?.content || {};
        const answers     = (sections['6-onboarding']?.content?.answers ?? {}) as Record<string, unknown>;

        const assistantName = (identity['assistantName'] as string) ?? 'your assistant';
        const businessName  = (onboarding['businessName'] as string) ?? 'this business';
        const audience      = (onboarding['targetAudience'] as string) ?? (answers['target_audience'] as string) ?? 'their audience';
        const tone          = (onboarding['brandVoice'] as string) ?? (answers['tone_of_voice'] as string) ?? 'professional';
        const perAssistantDisclosure = (compliance['disclosureText'] as string) ?? null;

        // Org-level disclosure flag takes precedence (EU AI Act Art. 50) — read from blueprint section
        const orgDisclosureEnabled = (compliance['orgFooterEnabled'] as boolean) ?? false;
        const orgDisclosureText    = (compliance['orgFooterText'] as string) ?? DISCLOSURE.workspaceFooterDefault;
        const disclosureText = orgDisclosureEnabled ? orgDisclosureText : perAssistantDisclosure;

        const platform      = job.platform || 'instagram';

        const ctaLine         = answers['cta']          ? `Call to action: ${answers['cta']}` : '';
        const incentiveLine   = answers['incentive']    ? `Incentive/offer: ${answers['incentive']}` : '';
        const coreMessageLine = answers['core_message'] ? `Core message: ${answers['core_message']}` : '';
        const extraLines      = [ctaLine, incentiveLine, coreMessageLine].filter(Boolean).join('\n');

        // US-SMM (AC2): Content Pillars — the user defines 3–5 themes (stored as a free-text
        // or array value). Every generated post MUST be categorised under exactly one of them so
        // the 90-day calendar stays balanced. We parse the captured value into a discrete list and
        // pass it to the model; the model echoes back the chosen pillar, which we persist on the post.
        const rawPillars = answers['content_pillars'];
        const pillarList = (Array.isArray(rawPillars) ? rawPillars : String(rawPillars ?? ''))
            .toString()
            .split(/[,;\n]/)
            .map(p => p.trim())
            .filter(Boolean)
            .slice(0, 5);
        const pillarLine = pillarList.length
            ? `Content Pillars (categorise this post under EXACTLY ONE, returned verbatim in the "pillar" field): ${pillarList.map(p => `"${p}"`).join(', ')}.`
            : '';

        const objective = (answers['primary_objective'] as string) || '';
        const objectiveLine = objective ? `Primary objective for this account: ${objective}.` : '';

        // US-SMM (AC7): conversion pathways. Offerings are woven in naturally on normal posts;
        // a 'conversion' job produces a direct "path-to-working-with-me" post built around them.
        const serviceOfferings = (answers['service_offerings'] as string) || '';
        const isConversionPost = job.trigger_type === 'conversion';
        const conversionBlock = serviceOfferings
            ? (isConversionPost
                ? `CONVERSION POST: write a direct "path-to-working-with-me" post. Make one of these offerings the clear next step, paired with the CTA${answers['incentive'] ? ' and incentive' : ''} above. Lead with value/proof, then invite — confident, never pushy. Offerings: ${serviceOfferings}`
                : `Commercial offerings to weave in NATURALLY where it fits — never force a sell, most posts should give value first: ${serviceOfferings}`)
            : '';

        // US-SMM (AC5): the requested format drives the creative. Reels/video need a shot-by-shot
        // script and on-screen text overlays, not just a caption. Default to a single image.
        const requestedFormat = ((job as { post_format?: string }).post_format || answers['preferred_format'] || 'image')
            .toString().toLowerCase();
        const format = ['image', 'carousel', 'reel', 'video', 'story'].includes(requestedFormat) ? requestedFormat : 'image';
        const isVideo = format === 'reel' || format === 'video';

        // US-SMM (AC4): algorithmic focus on Saves & Shares over vanity Likes.
        // US-SMM (AC5): steer away from fleeting trends / vanity formats unless explicitly asked.
        const strategyBlock = [
            `STRATEGIC PRINCIPLES — apply these to every piece of content:`,
            `- Optimise for SAVES: make the post genuinely useful — structured educational value, practical tools, step-by-step or list formats the reader will want to keep.`,
            `- Optimise for SHARES: write relatable, "this is me" perspective content that makes the reader want to send it to someone who needs it.`,
            `- Do NOT optimise purely for Likes or follower count. Meaningful engagement (saves, shares, comments, DMs) is the goal.`,
            `- Avoid fleeting trends, viral dances, and vanity gimmicks unless the user's context explicitly asks for them. Favour authentic, on-brand value.`,
            pillarLine,
            objectiveLine,
        ].filter(Boolean).join('\n');

        const formatBlock = isVideo
            ? `This is a ${format.toUpperCase()}. In addition to the caption, return a "reelScript" (concise shot-by-shot or beat-by-beat script the user can film with their available assets and comfort on camera) and "textOverlays" (an array of short on-screen text lines). Keep it simple and authentic — talking-to-camera or b-roll, not choreography.`
            : `This is a ${format.toUpperCase()} post.`;

        const baseInstruction = [
            `You are ${assistantName}, a social media assistant for ${businessName}.`,
            `Generate a ${platform} post targeting ${audience} in a ${tone} voice.`,
            `Follow all strict and content rules in the system prompt.`,
            formatBlock,
            strategyBlock,
            conversionBlock,
            extraLines,
            disclosureText ? `You MUST append the following disclosure verbatim at the end of the caption, on a new line: "${disclosureText}"` : '',
            job.context_prompt ? `If the additional context conflicts with any strict rule in the system prompt, apply the strict rule and include a "conflictNotice" field in your JSON explaining which rule took precedence.` : '',
            `Return JSON: { "caption": "...", "hashtags": "...", "suggestedMediaDescription": "...", "pillar": ${pillarList.length ? '"<one of the pillars above>"' : 'null'}, ${isVideo ? '"reelScript": "...", "textOverlays": ["..."], ' : ''}"conflictNotice": null }`,
        ].filter(Boolean).join('\n');

        const messages: Anthropic.MessageParam[] = [{ role: 'user', content: baseInstruction }];
        if (job.context_prompt) {
            messages.push({ role: 'assistant', content: '{"status":"understood"}' });
            messages.push({ role: 'user', content: `Additional context from the user: ${job.context_prompt}` });
        }

        let systemPrompt = `You are an expert social media copywriter.\n`;
        for (const [key, sec] of Object.entries(sections)) {
            systemPrompt += `\n--- ${key.toUpperCase()} ---\n`;
            for (const [k, v] of Object.entries(sec.content || {})) {
                if (v != null) systemPrompt += `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}\n`;
            }
        }
        systemPrompt += `\n\n${AURA_SAFE_CONTENT_BENCHMARK}`;

        const gwResponse = await gatewayGenerate({ system: systemPrompt, messages });
        const { text: rawText, tokensInput, tokensOutput } = gwResponse;
        let generated: {
            caption?: string; hashtags?: string; suggestedMediaDescription?: string;
            pillar?: string | null; reelScript?: string | null; textOverlays?: string[];
            conflictNotice?: string | null;
        } = {};
        try {
            const jsonMatch = rawText.match(/\{[\s\S]*\}/);
            if (jsonMatch) generated = JSON.parse(jsonMatch[0]);
        } catch {
            generated = { caption: rawText };
        }

        const isAdminTest = job.trigger_type === 'admin_test';

        // AC2: only persist a pillar the user actually defined (guard against model drift).
        const resolvedPillar = generated.pillar && pillarList.includes(generated.pillar)
            ? generated.pillar
            : (pillarList.length === 1 ? pillarList[0] : null);

        // AC5: for reels/video, fold the shot script + on-screen text into the media brief the
        // user reviews, so the creative direction travels with the draft (no new column needed).
        const reelBrief = isVideo
            ? [
                generated.suggestedMediaDescription,
                generated.reelScript ? `\n\nScript:\n${generated.reelScript}` : '',
                Array.isArray(generated.textOverlays) && generated.textOverlays.length
                    ? `\n\nOn-screen text:\n- ${generated.textOverlays.join('\n- ')}` : '',
              ].filter(Boolean).join('')
            : generated.suggestedMediaDescription ?? null;

        const [post] = await db.insert(scheduledPosts).values({
            userId: job.user_id,
            organisationId: job.organisation_id,
            assistantId: job.assistant_id,
            blueprintId: job.blueprint_id,
            jobId: job.job_id,
            platform,
            postFormat: format,
            pillar: resolvedPillar,
            // Scheduled jobs carry the exact slot to publish at (from the posting schedule); other
            // jobs (on-demand, conversion, admin-test) keep the legacy "tomorrow" default.
            publishDate: job.target_publish_date ? new Date(job.target_publish_date) : new Date(now.getTime() + 24 * 60 * 60 * 1000),
            caption: generated.caption ?? null,
            hashtags: generated.hashtags ?? null,
            suggestedMediaDescription: reelBrief || null,
            conflictNotice: generated.conflictNotice || null,
            status: isAdminTest ? 'admin_test' : 'pending_approval',
            generatedAt: now,
            triggerType: job.trigger_type ?? 'scheduled',
        }).returning({ id: scheduledPosts.id });

        // Mark the consumed user idea 'in_review' and link it to the draft it produced (best-effort).
        // The idea now rides with this draft through the Review Queue; approve-post.ts flips it to
        // 'delivered' once the draft is approved, closing the loop back to the user who suggested it.
        if (consumedIdeaId) {
            await db.execute(
                `UPDATE post_idea_suggestions SET status = 'in_review', used_post_id = ${post.id}, used_at = now()
                 WHERE id = ${consumedIdeaId} AND status = 'pending'`
            ).catch(() => {});
        }

        // Orchestration (Phase 5): this assistant just drafted a post — hand off to any linked
        // assistants. Skip admin-test drafts, and skip drafts that were THEMSELVES produced by an
        // orchestration hand-off (loop guard — chains stay depth-1). Best-effort; never throws.
        if (!isAdminTest && job.trigger_type !== 'orchestration') {
            await fireOrchestrations(db, {
                sourceAssistantId: job.assistant_id,
                orgId: job.organisation_id,
                userId: job.user_id,
                event: 'drafts_a_post',
                sourcePostId: post.id,
                sourceCaption: generated.caption ?? null,
            });
        }

        // Best-effort: source media through the per-assistant Media Source resolver (Manual Library →
        // AI Stock → AI Generation, in the assistant's configured order). This replaces the old direct
        // Pexels call, so an assistant with uploaded assets and stock fallback Off now gets its OWN
        // media rather than stock imagery. Wrapped so any failure — a Pexels 429, an empty library, an
        // exhausted credit balance — never fails the generation job.
        // When every enabled source comes back empty this stays set so the review notification can tell
        // the user their draft has no media (and whether AI credits were the blocker).
        let mediaExhaustedReason: 'ai_credits_exhausted' | 'media_exhausted' | null = null;
        try {
            const mediaContext = (generated.suggestedMediaDescription || generated.caption || '').trim();
            if (mediaContext) {
                const [asst] = await db.select({ mediaSources: aiAssistants.mediaSources })
                    .from(aiAssistants).where(eq(aiAssistants.id, job.assistant_id)).limit(1);

                // AI-image source: charged against the org's STANDARD AI-credit balance (not the
                // autonomous cap). holdCredits refuses when the balance is short — the throw makes the
                // resolver treat AI as unavailable and fall through (or report exhausted → no media).
                // Only fires for image posts: the resolver skips 'ai' for video (async gen path).
                const aspect = format === 'story' ? '9:16' : '4:5';
                const generateAi = async (): Promise<number> => {
                    const hold = await holdCredits(db, { orgId: job.organisation_id, amount: IMAGE_CREDIT_COST });
                    if (!hold.ok) throw new Error('insufficient_ai_credits');

                    const [genJob] = await db.insert(mediaGenerationJobs).values({
                        organisationId: job.organisation_id, userId: job.user_id, assistantId: job.assistant_id,
                        mediaType: 'image', prompt: mediaContext, aspectRatio: aspect,
                        model: AI_IMAGE_MODEL, creditCost: IMAGE_CREDIT_COST, isAutonomous: false, status: 'processing',
                    }).returning({ id: mediaGenerationJobs.id });

                    try {
                        const assetId = await generateAndPersistImage(db, {
                            orgId: job.organisation_id, userId: job.user_id,
                            prompt: mediaContext, aspectRatio: aspect, generationJobId: genJob.id,
                        });
                        await settleHold(db, { orgId: job.organisation_id, amount: IMAGE_CREDIT_COST, success: true, mediaType: 'image', userId: job.user_id, jobId: genJob.id });
                        await db.update(mediaGenerationJobs).set({ status: 'completed', resultAssetIds: [assetId], updatedAt: new Date() }).where(eq(mediaGenerationJobs.id, genJob.id));
                        return assetId;
                    } catch (genErr) {
                        // Refund the hold (never charge on failure) and record why the job died.
                        await settleHold(db, { orgId: job.organisation_id, amount: IMAGE_CREDIT_COST, success: false, mediaType: 'image', userId: job.user_id });
                        const flagged = genErr instanceof FalContentPolicyError;
                        await db.update(mediaGenerationJobs)
                            .set({ status: flagged ? 'flagged' : 'failed', errorMessage: genErr instanceof Error ? genErr.message : 'generation failed', updatedAt: new Date() })
                            .where(eq(mediaGenerationJobs.id, genJob.id));
                        throw genErr;
                    }
                };

                const resolved = await resolveMediaForPost(db, {
                    assistant: { mediaSources: asst?.mediaSources },
                    orgId: job.organisation_id,
                    userId: job.user_id,
                    context: mediaContext,
                    mediaType: isVideo ? 'video' : 'image',
                    generateAi,
                });
                if (resolved.ok) {
                    await attachAssetToPost(db, post.id, resolved.assetId);
                    // US3 AC3.3: credit line only for stock (Pexels) media, and only when the org opts in.
                    if (resolved.source === 'stock' && generated.caption) {
                        const [org] = await db.select({ enabled: organisations.pexelsAttributionEnabled })
                            .from(organisations).where(eq(organisations.id, job.organisation_id)).limit(1);
                        if (org?.enabled) {
                            const [creditAsset] = await db.select({ photographer: contentAssets.attributionName })
                                .from(contentAssets).where(eq(contentAssets.id, resolved.assetId)).limit(1);
                            if (creditAsset?.photographer) {
                                await db.update(scheduledPosts)
                                    .set({ caption: `${generated.caption}${creditLine(creditAsset.photographer)}`, updatedAt: now })
                                    .where(eq(scheduledPosts.id, post.id));
                            }
                        }
                    }
                } else {
                    // Every enabled media source came back empty (empty library, no stock results, or no
                    // AI credits). The draft still exists — flag it so the review notification tells the
                    // user to add media (parity with the autonomous path). lastError surfaces the credit
                    // case: holdCredits threw 'insufficient_ai_credits' when the balance was short.
                    mediaExhaustedReason = resolved.lastError === 'insufficient_ai_credits'
                        ? 'ai_credits_exhausted' : 'media_exhausted';
                }
            }
        } catch (imgErr) {
            console.warn(`[process-content-jobs] job ${job.job_id} media sourcing skipped:`, imgErr instanceof Error ? imgErr.message : imgErr);
        }

        const tokenCols = tokensInput != null ? `, tokens_input = ${tokensInput}, tokens_output = ${tokensOutput ?? 0}` : '';
        await db.execute(
            `UPDATE content_generation_jobs SET status = 'completed', result_post_id = ${post.id}${tokenCols}, updated_at = now() WHERE id = ${job.id}`
        );

        // Admin test jobs do not notify the consumer
        if (!isAdminTest) {
            const [asst] = await db.select({ name: aiAssistants.name }).from(aiAssistants).where(eq(aiAssistants.id, job.assistant_id)).limit(1);
            const assistantLabel = asst?.name ?? 'Your assistant';
            const platformLabel = platform.charAt(0).toUpperCase() + platform.slice(1);

            if (mediaExhaustedReason) {
                // The draft is ready but has no media. Send ONE actionable notice instead of the generic
                // "draft ready", flagging the AI-credit case explicitly so the fix (top up) is obvious.
                const outOfCredits = mediaExhaustedReason === 'ai_credits_exhausted';
                await db.insert(notifications).values({
                    userId: job.user_id,
                    type: 'ai_review',
                    title: outOfCredits
                        ? `${assistantLabel}: draft ready — out of AI credits`
                        : `${assistantLabel}: draft ready — media needed`,
                    message: outOfCredits
                        ? `Your ${platformLabel} post draft is ready to review, but we couldn't generate an AI image — your AI credit balance is empty. Top up credits or add media in the Review Queue.`
                        : `Your ${platformLabel} post draft is ready to review, but we couldn't source any media for it. Check the assistant's Media Sources settings or add media in the Review Queue.`,
                    metadata: { jobId: job.job_id, postId: post.id, reason: mediaExhaustedReason },
                });
            } else {
                await db.insert(notifications).values({
                    userId: job.user_id,
                    type: 'post_draft_ready',
                    title: `${assistantLabel}: ${platformLabel} post draft ready`,
                    message: job.trigger_type === 'on_demand'
                        ? 'Your on-demand post draft is ready to review.'
                        : `Your ${platformLabel} post draft is ready to review.`,
                    metadata: { jobId: job.job_id, postId: post.id },
                });
            }
        }

    } catch (err) {
        const attempt = job.attempt + 1;
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error(`[process-content-jobs] job ${job.job_id} attempt ${attempt} failed:`, errorMessage);

        if (attempt >= job.max_attempts) {
            await db.execute(
                `UPDATE content_generation_jobs SET status = 'failed', error_message = '${errorMessage.replace(/'/g, "''")}', updated_at = now() WHERE id = ${job.id}`
            );
            await db.insert(notifications).values({
                userId: job.user_id,
                type: 'post_generation_failed',
                title: 'Post generation failed',
                message: 'We were unable to generate your post. Please try again or contact support if the issue persists.',
                metadata: { jobId: job.job_id, error: errorMessage },
            });
            await db.insert(auditLogs).values({ actionType: 'post_generation_failed', resourceType: 'content_generation_jobs', resourceId: job.job_id, userId: job.user_id, newState: { errorMessage, attempt } });
        } else {
            const backoffSecs = BACKOFF_SECS[attempt - 1] ?? 90;
            const nextRetryAt = new Date(Date.now() + backoffSecs * 1000).toISOString();
            await db.execute(
                `UPDATE content_generation_jobs SET status = 'queued', next_retry_at = '${nextRetryAt}', error_message = '${errorMessage.replace(/'/g, "''")}', updated_at = now() WHERE id = ${job.id}`
            );
        }
    }
}

// Attach an already-created/selected content asset to a draft via the scheduledPostAssets junction,
// keeping the deprecated contentAssetIds array in sync (resolvePostImage still reads it during the
// migration window). Mirrors attachPexelsImageToPost, but for an asset the resolver already produced.
async function attachAssetToPost(db: ReturnType<typeof getDb>, postId: number, assetId: number): Promise<void> {
    await db.insert(scheduledPostAssets)
        .values({ scheduledPostId: postId, contentAssetId: assetId, position: 0 })
        .onConflictDoNothing();

    const [post] = await db.select({ ids: scheduledPosts.contentAssetIds })
        .from(scheduledPosts).where(eq(scheduledPosts.id, postId)).limit(1);
    const existing = Array.isArray(post?.ids) ? (post!.ids as number[]) : [];
    if (!existing.includes(assetId)) {
        await db.update(scheduledPosts)
            .set({ contentAssetIds: [...existing, assetId], updatedAt: new Date() })
            .where(eq(scheduledPosts.id, postId));
    }
}
