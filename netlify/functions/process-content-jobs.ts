// netlify/functions/process-content-jobs.ts
// US-SMM-3.1.1 + US-SMM-3.4.1: Drains the content_generation_jobs queue every minute.
// Uses FOR UPDATE SKIP LOCKED to safely handle concurrent cron ticks.

import { Handler } from '@netlify/functions';
import Anthropic from '@anthropic-ai/sdk';
import { eq, and, inArray, isNotNull, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import {
    contentGenerationJobs, aiBlueprints, aiAssistants,
    scheduledPosts, scheduledPostAssets, contentAssets, mediaGenerationJobs,
    auditLogs, organisations, systemConnections,
} from '../../db/schema';
import { createNotification } from '../../src/utils/notify';
import { gatewayGenerate } from '../../src/lib/ai-gateway';
import { buildInspoBlock } from '../../src/utils/inspo-profile';
import { AURA_SAFE_CONTENT_BENCHMARK } from '../../src/constants/safety-benchmark';
import { CONTENT_QUALITY_STANDARDS } from '../../src/constants/content-quality';
import { creditLine } from '../../src/utils/pexels';
import { resolveMediaForPost } from '../../src/utils/media-resolver';
import { holdCredits, settleHold, IMAGE_CREDIT_COST } from '../../src/utils/ai-credits';
import { generateAndPersistImage, renderAndPersistBrandCard } from '../../src/lib/media-persist';
import { headlineFromCaption, MAX_HEADLINE_CHARS } from '../../src/lib/brand-card';
import { resolveBrandKitForOrg } from '../../src/lib/brand-extract-fetch';
import { FalContentPolicyError } from '../../src/lib/fal-gateway';
import { resolveDisclosureFooter } from '../../src/utils/disclosure-footer';
import { fitForPlatform, isShortForm, type BrandHashtags } from '../../src/utils/platform-caption';
import { fireOrchestrations } from '../../src/utils/orchestration';
import { operationalSetupLines } from '../../src/utils/operational-setup';
import {
    buildVarietyBlock, VARIETY_LOOKBACK, findNearDuplicate, nearDuplicateRetryPrompt,
    type PriorPost,
} from '../../src/utils/draft-variety';
import { decideAutoPublish, describeDecision } from '../../src/utils/auto-publish-runtime';
import { platformFormat, SOCIAL_PLATFORMS } from '../../src/config/platform-formats';
import { formatPlatformStrategyBrief, platformStrategyFor, type PlatformStrategy } from '../../src/utils/platform-strategy-brief';
import { parseModelJson } from '../../src/utils/model-json';
import { hasFeatureByOrg } from '../../src/utils/plan-features';
import { reviewDraftGroup } from '../../src/utils/post-quality-review';
import type { MediaSource } from '../../src/utils/publish-policy';
import { withLambda } from '@netlify/aws-lambda-compat';

// Fal image model for inline AI generation (matches the autonomous suggestions path).
const AI_IMAGE_MODEL = process.env.FAL_IMAGE_MODEL ?? 'fal-ai/flux-pro/v1.1';

const BACKOFF_SECS = [10, 30, 90];

// Blueprint COMPLIANCE keys withheld from the system prompt. These carry the literal disclosure
// text, which the code appends itself after generation — putting it in front of the model only
// teaches it to write a second copy into the caption.
const DISCLOSURE_PROMPT_BLOCKLIST = new Set(['disclosureText', 'orgFooterText', 'orgFooterEnabled']);

// Scheduled/conversion jobs (draft-horizon-fill.ts, schedule-conversion-posts.ts) never set
// job.platform, so fall back to the org's actual connection instead of a hardcoded platform.
//
// The candidate list is the shared catalogue, NOT a local array. It used to be a hand-written
// four — instagram/facebook/linkedin/x — which meant an org connected only to Threads or YouTube
// matched nothing here and fell through to the 'instagram' default, drafting every autopilot and
// conversion post for a platform it cannot publish to.
async function resolveFallbackPlatform(db: ReturnType<typeof getDb>, organisationId: number): Promise<string> {
    const [conn] = await db
        .select({ serviceName: systemConnections.serviceName })
        .from(systemConnections)
        .where(and(
            eq(systemConnections.organisationId, organisationId),
            eq(systemConnections.isActive, true),
            inArray(systemConnections.serviceName, SOCIAL_PLATFORMS as unknown as string[]),
        ))
        .orderBy(systemConnections.createdAt)
        .limit(1);
    return conn?.serviceName ?? 'instagram';
}

// Core queue drain: reset stuck jobs, claim up to 20 queued jobs, generate each. Returns the
// number of jobs claimed this pass. Extracted from the handler so it can be driven both by the
// native Netlify schedule (this file's `handler`) AND by an on-demand HTTP trigger
// (run-content-jobs.ts) — the latter is how staging/branch deploys drain their queue, since
// Netlify only runs scheduled functions on the production deploy.
export async function drainContentJobs(): Promise<number> {
    const db = getDb();
    const now = new Date();

    // Reset jobs stuck in 'processing' for >3 minutes (function timed out mid-run).
    // Scoped to social: process-blog-jobs.ts owns the recovery of its own stuck jobs, and it uses a
    // longer window because blog drafting is a slower call than a social post.
    await db.execute(
        `UPDATE content_generation_jobs SET status = 'queued', next_retry_at = now()
         WHERE status = 'processing' AND content_type = 'social'
           AND updated_at < now() - interval '3 minutes' AND attempt < max_attempts`
    );
    // ...and terminally-stuck ones (already at max attempts) get failed rather than lingering in
    // 'processing' forever — the reclaimer above only requeues those with retries left.
    await db.execute(
        `UPDATE content_generation_jobs SET status = 'failed', error_message = 'stuck in processing (timed out) at max attempts', updated_at = now()
         WHERE status = 'processing' AND content_type = 'social'
           AND updated_at < now() - interval '3 minutes' AND attempt >= max_attempts`
    );

    const jobs = await db.execute<{
        id: number; job_id: string; blueprint_id: number; assistant_id: number;
        organisation_id: number; user_id: number; attempt: number; max_attempts: number;
        context_prompt: string | null; trigger_type: string | null; platform: string | null;
        admin_id: number | null; target_publish_date: string | null; crosspost_group_id: string | null;
        platforms: string[] | null;
    }>(
        `SELECT id, job_id, blueprint_id, assistant_id, organisation_id, user_id, attempt, max_attempts,
                context_prompt, trigger_type, platform, admin_id, target_publish_date, crosspost_group_id,
                platforms
         FROM content_generation_jobs
         WHERE status = 'queued'
           AND content_type = 'social'
           AND (next_retry_at IS NULL OR next_retry_at <= now())
         ORDER BY created_at
         LIMIT 20
         FOR UPDATE SKIP LOCKED`
    );

    if (!jobs.length) return 0;

    // Heavy fan-out jobs (AI image gen + a confidence-scoring call PER platform) can each run ~15-20s,
    // so draining all fetched jobs at once in parallel blows the 26s function cap → 504, and jobs die
    // mid-run in 'processing' (recovered by the reclaimer above, but only after 3 min). Instead process
    // in small concurrent chunks and stop STARTING new work once we're near the budget; whatever we
    // didn't start is still 'queued' for the next 10-min cron tick (or manual trigger). Light text-only
    // jobs finish fast, so several chunks fit; heavy image jobs get ~one chunk per invocation.
    const CONCURRENCY = 2;
    const START_BUDGET_MS = 8_000;   // ~18s slowest chunk started by 8s still lands under the 26s cap
    const startedAt = Date.now();
    let processed = 0;
    for (let i = 0; i < jobs.length; i += CONCURRENCY) {
        if (i > 0 && Date.now() - startedAt > START_BUDGET_MS) break; // always run at least one chunk
        const chunk = jobs.slice(i, i + CONCURRENCY);
        await Promise.allSettled(chunk.map(job => processJob(db, job, now)));
        processed += chunk.length;
    }

    return processed;
}

export default withLambda(async () => {
    const processed = await drainContentJobs();
    return { statusCode: 200, body: processed ? `processed ${processed} jobs` : 'no jobs' };
});

async function processJob(db: ReturnType<typeof getDb>, job: {
    id: number; job_id: string; blueprint_id: number; assistant_id: number;
    organisation_id: number; user_id: number; attempt: number; max_attempts: number;
    context_prompt: string | null; trigger_type: string | null; platform: string | null;
    admin_id: number | null; target_publish_date: string | null; crosspost_group_id: string | null;
    platforms: string[] | null;
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
            // Atomically CLAIM the oldest pending idea in one statement: FOR UPDATE SKIP LOCKED means
            // sibling jobs draining the same batch in parallel each lock and take a DIFFERENT row, and
            // flipping status here (not after the insert) closes the window where two jobs could read
            // the same 'pending' idea and generate identical posts. Reverted to 'pending' on failure
            // (see the catch below) so a crashed job doesn't strand the idea.
            const [idea] = await db.execute<{ id: number; idea: string }>(
                `UPDATE post_idea_suggestions SET status = 'in_review', used_at = now()
                 WHERE id = (
                     SELECT id FROM post_idea_suggestions
                     WHERE assistant_id = ${job.assistant_id} AND status = 'pending'
                     ORDER BY created_at ASC
                     FOR UPDATE SKIP LOCKED
                     LIMIT 1
                 )
                 RETURNING id, idea`
            );
            if (idea) { job.context_prompt = idea.idea; consumedIdeaId = idea.id; }
        } catch (e) {
            console.warn(`[process-content-jobs] idea claim skipped for job ${job.job_id}:`, e instanceof Error ? e.message : e);
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

        // EU AI Act Art. 50 disclosure footer, resolved DETERMINISTICALLY (was an LLM "append this
        // verbatim" instruction). Doing it in code guarantees the exact compliance string is never
        // reworded/dropped by the model, and — because the text is now known — lets the user strip it
        // from a single post (per-post opt-out; see toggle-post-disclosure.ts). Org footer wins when
        // enabled (Art. 50), else the per-assistant disclosure. {assistant} → this assistant's name.
        const disclosureFooter = resolveDisclosureFooter({
            orgEnabled: (compliance['orgFooterEnabled'] as boolean) ?? false,
            orgText: (compliance['orgFooterText'] as string | null) ?? null,
            perAssistantText: perAssistantDisclosure,
            assistantName,
        });

        // Per-assistant brand hashtag governance. onboardingContext.brandHashtags = the canonical tags
        // to always include (spelled exactly); onboardingContext.hashtagAliases = variant→canonical
        // rewrites (e.g. HireDontLearn→HireNotLearn). Read live from onboardingContext so a config
        // change applies without waiting on a blueprint recompile. Empty ⇒ generic hygiene only.
        const [asstCfg] = await db.select({ onboardingContext: aiAssistants.onboardingContext })
            .from(aiAssistants).where(eq(aiAssistants.id, job.assistant_id)).limit(1);
        const brandCtx = (asstCfg?.onboardingContext ?? {}) as Record<string, unknown>;
        const rawCanon = brandCtx.brandHashtags;
        const canonicalTags = (Array.isArray(rawCanon) ? rawCanon.map(String)
            : typeof rawCanon === 'string' ? rawCanon.split(/[\s,]+/) : [])
            .map(s => s.replace(/^#+/, '').trim()).filter(Boolean);
        const brandHashtags: BrandHashtags = {
            canonical: canonicalTags,
            aliases: (brandCtx.hashtagAliases && typeof brandCtx.hashtagAliases === 'object')
                ? brandCtx.hashtagAliases as Record<string, string> : {},
        };
        const brandTagLine = canonicalTags.length
            ? `BRAND HASHTAGS — ALWAYS include these exact tags, spelled exactly as shown: ${canonicalTags.map(t => '#' + t).join(' ')}. You may add a few more relevant tags, but never re-spell or vary the brand tags.`
            : '';

        // One-idea fan-out: when the job carries a platforms list we generate ONE caption/media and
        // create a post for each platform (siblings share crosspost_group_id → one Review Queue card).
        // `platform` is the representative used for the prompt aspect ratio + the primary post; the
        // rest are cloned after. Legacy single-platform jobs keep platforms empty → targetPlatforms is
        // just [platform], and everything below runs exactly as before.
        const fanoutPlatforms = Array.isArray(job.platforms)
            ? job.platforms.filter((p): p is string => typeof p === 'string' && p.length > 0)
            : [];
        const fanOut = fanoutPlatforms.length > 1;
        const platform      = (fanoutPlatforms[0] || job.platform) || await resolveFallbackPlatform(db, job.organisation_id);
        const targetPlatforms = fanoutPlatforms.length ? fanoutPlatforms : [platform];
        // Platform-agnostic wording when one idea spans several platforms (the same idea ships to all,
        // but each platform now gets a length/hashtag-appropriate variant — see fitForPlatform below).
        const promptPlatform = fanOut ? 'social media' : platform;
        // When any target platform is short-form (X/Threads), ask the model for a standalone short
        // caption too, so those platforms don't inherit the LinkedIn-length essay verbatim.
        const needsShort = targetPlatforms.some(isShortForm);

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
        // Variety: rotate the pillar by the slot's calendar day instead of letting every slot pick the
        // same (strongest) pillar. Day-of-epoch % pillarCount walks the pillars across the calendar, so
        // consecutive scheduled posts land on different themes with no cross-job coordination needed.
        // On-demand jobs (no slot) keep the "choose exactly one" behaviour.
        const rotatedPillar = (pillarList.length && job.target_publish_date)
            ? pillarList[Math.floor(new Date(job.target_publish_date).getTime() / 86_400_000) % pillarList.length]
            : null;
        const pillarLine = rotatedPillar
            ? `Content Pillar for THIS post — write it under this pillar and return it verbatim in the "pillar" field: "${rotatedPillar}". Do NOT drift to another pillar; rotating pillars across the calendar is what keeps the feed varied.`
            : (pillarList.length
                ? `Content Pillars (categorise this post under EXACTLY ONE, returned verbatim in the "pillar" field): ${pillarList.map(p => `"${p}"`).join(', ')}.`
                : '');

        // Batch-internal variety: assign each slot a DIFFERENT opening-hook style so the parallel
        // siblings in one drafting batch don't all reach for the same hook — they generate
        // independently and can't see each other, so pillar rotation alone still let every post open
        // with the same formula. Derived deterministically from the slot's hour (no coordination or
        // storage needed); a prime-length (7) list coprime with the 24h day-step keeps daily slots
        // cycling through ALL styles instead of aliasing onto one. On-demand jobs (no slot) stay free.
        const HOOK_STYLES = [
            'a provocative question aimed straight at the target reader',
            'a surprising statistic or a concrete number',
            'a short, vivid "this is you right now" scenario (one or two lines)',
            'a widely-believed myth stated plainly, then busted',
            'a bold, mildly contrarian claim',
            'a sharp pain-point callout',
            'a before/after contrast (the messy now vs. the calmer after)',
        ];
        const hookStyle = job.target_publish_date
            ? HOOK_STYLES[Math.floor(new Date(job.target_publish_date).getTime() / 3_600_000) % HOOK_STYLES.length]
            : null;
        const hookLine = hookStyle
            ? `OPENING HOOK for THIS post — open with ${hookStyle}. (The standing hook rules — vary the opening, never reuse a formula, the banned "you didn't start a business to become…" line — are in the Content Quality Standards below.)`
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

        // Variety (anti-repetition): show the model this assistant's most recent captions so it brings
        // a fresh angle instead of collapsing onto the same premise every slot. Best-effort — a lookup
        // failure never blocks the draft. Siblings drafted in the SAME parallel batch aren't visible
        // here yet; the pillar rotation above + the distinct claimed idea keep those apart.
        //
        // No status filter, deliberately: a draft awaiting review, one already scheduled and one
        // published all count as "we have said this already".
        //
        // ORDER BY matters more than it looks. This was `generated_at DESC`, and Postgres sorts
        // NULLs FIRST on a DESC ordering — so every post with no generated_at (the calendar
        // composer never set it, nor did the revised clone a rejection creates) sorted to the TOP
        // and filled all the slots, pushing out the genuinely recent AI drafts this block exists to
        // show. An assistant with a handful of hand-composed posts was effectively drafting with no
        // anti-repetition context at all. created_at is NOT NULL, so the coalesce always sorts by a
        // real timestamp and hand-written posts take their rightful place by age instead of jumping
        // the queue or being exiled to the end.
        // Declared out here because the near-duplicate gate after generation checks the new caption
        // against this SAME corpus — one fetch serves both the prompt and the verification.
        let recent: PriorPost[] = [];
        let recentBlock = '';
        try {
            recent = await db.select({ caption: scheduledPosts.caption, media: scheduledPosts.suggestedMediaDescription })
                .from(scheduledPosts)
                .where(and(eq(scheduledPosts.assistantId, job.assistant_id), isNotNull(scheduledPosts.caption)))
                .orderBy(sql`coalesce(${scheduledPosts.generatedAt}, ${scheduledPosts.createdAt}) desc`)
                .limit(VARIETY_LOOKBACK);
            recentBlock = buildVarietyBlock(recent);
        } catch { /* best-effort; variety context is a nicety, never a blocker */ }

        // US-SMM (AC5): the requested format drives the creative. Reels/video need a shot-by-shot
        // script and on-screen text overlays, not just a caption. Default to a single image.
        const requestedFormat = ((job as { post_format?: string }).post_format || answers['preferred_format'] || 'image')
            .toString().toLowerCase();
        const format = ['image', 'carousel', 'reel', 'video', 'story'].includes(requestedFormat) ? requestedFormat : 'image';
        const isVideo = format === 'reel' || format === 'video';

        // The standing strategic principles (saves/shares, no vanity metrics, avoid fleeting trends)
        // now live in the CONTENT_QUALITY_STANDARDS system-prompt block, appended below like the safety
        // benchmark. This block carries only what's dynamic per post: the slot's rotated pillar and the
        // account's objective.
        const strategyBlock = [pillarLine, objectiveLine].filter(Boolean).join('\n');

        const formatBlock = isVideo
            ? `This is a ${format.toUpperCase()}. In addition to the caption, return a "reelScript" (concise shot-by-shot or beat-by-beat script the user can film with their available assets and comfort on camera) and "textOverlays" (an array of short on-screen text lines). Keep it simple and authentic — talking-to-camera or b-roll, not choreography.`
            : `This is a ${format.toUpperCase()} post.`;

        // Per-platform algorithm/format strategy (context.platform_strategy — captured at onboarding,
        // editable in the profile). Read LIVE from onboardingContext (like brand hashtags above) so an
        // edit applies without a blueprint recompile, and SCOPED to this job's platform(s) so a YouTube
        // "prioritise Shorts" rule never bleeds into a LinkedIn post. Without this the strategy only
        // reached the model as a raw JSON blob in the blueprint dump, not as an explicit directive.
        const scopedStrategy = platformStrategyFor(
            brandCtx.platform_strategy as PlatformStrategy | undefined,
            targetPlatforms,
        );
        const strategyBrief = scopedStrategy ? formatPlatformStrategyBrief(scopedStrategy) : null;
        const platformStrategyLine = strategyBrief
            ? `PLATFORM STRATEGY — follow these platform-specific directions:\n${strategyBrief}`
            : '';

        // Operational Setup (onboarding step 3) as explicit directives — see operational-setup.ts
        // for what each answer means and why content_source_detail is withheld. Read LIVE from
        // onboardingContext (like brand hashtags and platform strategy above) so a profile edit
        // applies without a blueprint recompile; section 6's copy is the fallback.
        const operationalLines = operationalSetupLines(brandCtx, answers);

        const baseInstruction = [
            `You are ${assistantName}, a social media assistant for ${businessName}.`,
            `Generate a ${promptPlatform} post targeting ${audience} in a ${tone} voice.`,
            `Follow all strict and content rules in the system prompt.`,
            // Before the creative direction: these bound what the post may claim, and a constraint
            // stated after the brief reads as an afterthought.
            ...operationalLines,
            formatBlock,
            strategyBlock,
            platformStrategyLine,
            hookLine,
            recentBlock,
            conversionBlock,
            extraLines,
            brandTagLine,
            // NB: the disclosure footer is appended in code after generation (inside fitForPlatform),
            // NOT requested from the model — so it is never reworded or omitted.
            job.context_prompt ? `If the additional context conflicts with any strict rule in the system prompt, apply the strict rule and include a "conflictNotice" field in your JSON explaining which rule took precedence.` : '',
            // Per-platform caption: the long "caption" is the full post (LinkedIn/Facebook/Instagram).
            // "captionShort" is a self-contained version for X/Threads — a punchy hook plus the link if
            // there is one, UNDER 200 characters, complete (never a truncated version of the long one),
            // and WITHOUT hashtags or the disclosure line (both are added in code).
            needsShort ? `Also return "captionShort": a standalone post for X/Threads — under 200 characters, a strong hook + the link if relevant, no hashtags, no sign-off. It must read as a complete post on its own, not a trimmed excerpt of the long caption.` : '',
            // Media: "suggestedMediaDescription" is the full art-direction brief (used only if the image
            // is AI-generated). "imageSearchQuery" is the LITERAL photo subject in 2–5 plain words for
            // stock search — real, photographable nouns only (e.g. "person relaxing with coffee"), never
            // design language like "split graphic", "logo", "text overlay", "typography", "crossed out".
            `Also return "imageSearchQuery": 2–5 plain words naming the literal, photographable subject for a stock-photo search — no design/graphic/logo/overlay wording, just the real-world scene.`,
            // Brand-card headline. A card is TYPOGRAPHY, so unlike the two media fields above this
            // one is the words themselves, not a description of a picture. Asked for on every image
            // post because the source is chosen after generation (see the media block) — and if it
            // comes back missing, headlineFromCaption() salvages one from the caption.
            isVideo ? '' : `Also return "cardHeadline": the post's single sharpest line, written to stand alone as large type on a plain branded card — under ${MAX_HEADLINE_CHARS} characters, no hashtags, no emoji, no link, no quotation marks, no trailing full stop.`,
            `Return JSON: { "caption": "...", ${needsShort ? '"captionShort": "...", ' : ''}"hashtags": "...", "suggestedMediaDescription": "...", "imageSearchQuery": "...", ${isVideo ? '' : '"cardHeadline": "...", '}"pillar": ${pillarList.length ? '"<one of the pillars above>"' : 'null'}, ${isVideo ? '"reelScript": "...", "textOverlays": ["..."], ' : ''}"conflictNotice": null }`,
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
                if (v == null) continue;
                // Never show the model the disclosure strings. They are appended DETERMINISTICALLY
                // in code (see resolveDisclosureFooter above), so the model has no use for them —
                // but the blueprint dumps every section verbatim, so it was reading its own
                // workspace footer and per-assistant disclosure and helpfully writing them into the
                // caption body. The result was up to three disclosures on one post: two echoed, one
                // appended. Withholding the text is the only fix that stops it at the source;
                // stripDisclosureEchoes() in platform-caption.ts cleans up what still slips through
                // (and covers blueprints compiled before this change).
                if (DISCLOSURE_PROMPT_BLOCKLIST.has(k)) continue;
                systemPrompt += `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}\n`;
            }
        }

        // Inspo (AC5) — the styles/tones the user parked in the Inspo tab. Injected here, NOT
        // as a blueprint section: sections are dumped wholesale above, so inspo living there
        // would grow the prompt with the user's library. buildInspoBlock is bounded (a capped
        // distilled profile + top-K retrieval) and returns null when there's nothing to add,
        // so a user with no inspo pays nothing. Placed after the blueprint so the assistant's
        // own strict rules are established first, and before the safety benchmark so that
        // always has the last word. Topic = the context prompt driving this specific draft.
        // Never throws — inspo degrades to nothing rather than failing the draft.
        const inspoBlock = await buildInspoBlock(db, {
            assistantId: job.assistant_id,
            organisationId: job.organisation_id,
            topic: job.context_prompt,
        });
        if (inspoBlock) systemPrompt += `\n\n${inspoBlock}`;

        systemPrompt += `\n\n${CONTENT_QUALITY_STANDARDS}`;
        systemPrompt += `\n\n${AURA_SAFE_CONTENT_BENCHMARK}`;

        // A long founder-story caption + hashtags + media description in one JSON blob overran the
        // gateway's 1024-token default and got cut off mid-sentence (the JSON then fails to parse and
        // a half-caption shipped). Give the structured reply real headroom.
        //
        // Raised 2048 → 4096 on 2026-07-23: 2048 was still overrunning in production (2 of 42 jobs
        // failed to parse). The reply carries caption + hashtags + suggestedMediaDescription +
        // reelScript + textOverlays in ONE object — a LinkedIn-length caption alone can be ~750
        // tokens, so the budget was being spent before the later fields were written. Output tokens
        // are only billed for what is generated, so the higher ceiling costs nothing on the replies
        // that were already fitting.
        const gwResponse = await gatewayGenerate({ system: systemPrompt, messages, maxTokens: 4096 });
        const { text: rawText, tokensInput, tokensOutput } = gwResponse;
        let generated: {
            caption?: string; captionShort?: string; hashtags?: string;
            suggestedMediaDescription?: string; imageSearchQuery?: string; cardHeadline?: string;
            pillar?: string | null; reelScript?: string | null; textOverlays?: string[];
            conflictNotice?: string | null;
        } = {};
        // The reply MUST be the JSON we asked for. If it doesn't parse (truncated, or the model went
        // off-format), throw rather than shipping toCaptionText(rawText) — that fallback surfaced
        // truncated half-captions in the review queue. Throwing lets the job retry (bounded by
        // max_attempts); a persistent format failure ends as 'failed' + a notification, never a
        // broken draft. A caption present but empty is treated the same way.
        const parsedReply = parseModelJson<typeof generated>(rawText);
        if (!parsedReply || !parsedReply.caption || !String(parsedReply.caption).trim()) {
            // Say WHICH failure it was. 'likely truncated' was a guess that sent us looking at the
            // prompt when the answer was the token ceiling — the gateway now reports stop_reason, so
            // a cut-off reply and a mis-formatted one are distinguishable in the logs and in the
            // error stored on the job.
            const truncated = gwResponse.stopReason === 'max_tokens';
            throw new Error(truncated
                ? `Model reply was cut off at the ${4096}-token ceiling before the JSON closed (wrote ${gwResponse.tokensOutput ?? '?'} tokens) — retrying`
                : `Model reply was not valid JSON with a caption (stop_reason: ${gwResponse.stopReason ?? 'unknown'}) — retrying`);
        }
        generated = parsedReply;

        // ── Near-duplicate gate ───────────────────────────────────────────────────────────────
        // The prompt ASKS for a different angle; this checks it got one. Compared against the same
        // `recent` corpus already fetched for the variety block — every status, so a draft awaiting
        // review counts as much as one already published — so the check itself costs no query and
        // no model call.
        //
        // On a trip: ONE corrective re-ask quoting the collision. Exactly one, then we take
        // whatever came back. An unbounded "try again" against a model that has already shown it
        // wants to write this idea is how a drafting job turns into a timeout, and the drainer runs
        // to a 26s cap. A second near-duplicate is a far better outcome than a failed job or an
        // empty queue slot, so the gate degrades to "we tried" rather than blocking the draft.
        //
        // Fail-open throughout: any error here leaves the original caption exactly as generated.
        let dupTokensIn = 0;
        let dupTokensOut = 0;
        try {
            const dup = findNearDuplicate(String(generated.caption ?? ''), recent);
            if (dup) {
                console.warn(`[process-content-jobs] job ${job.job_id}: near-duplicate (score ${dup.score.toFixed(2)}) — re-asking once`);
                const retry = await gatewayGenerate({
                    system: systemPrompt,
                    messages: [
                        ...messages,
                        { role: 'assistant', content: rawText },
                        { role: 'user', content: nearDuplicateRetryPrompt(dup) },
                    ],
                    maxTokens: 4096,
                });
                dupTokensIn = retry.tokensInput ?? 0;
                dupTokensOut = retry.tokensOutput ?? 0;
                const reparsed = parseModelJson<typeof generated>(retry.text);
                // Only take the retry if it is BOTH valid and actually different. A malformed or
                // still-duplicate second attempt leaves the first draft in place — swapping one
                // duplicate for another gains nothing, and throwing would waste a good draft.
                if (reparsed?.caption && String(reparsed.caption).trim()
                    && !findNearDuplicate(String(reparsed.caption), recent)) {
                    generated = reparsed;
                } else {
                    console.warn(`[process-content-jobs] job ${job.job_id}: re-ask did not clear the duplicate — keeping the first draft`);
                }
            }
        } catch (err) {
            console.warn(`[process-content-jobs] job ${job.job_id}: near-duplicate check skipped:`, err instanceof Error ? err.message : err);
        }

        // The raw model caption, WITHOUT the footer — kept for orchestration hand-off and as the
        // long-form source that fitForPlatform trims per platform. The disclosure footer (EU AI Act
        // Art. 50) is appended deterministically inside fitForPlatform for each platform, so every
        // stored caption — long or short — carries it, and the per-post opt-out still strips it.
        const rawCaption = String(generated.caption ?? '').trim();
        // captionFor(platform, credit?) → the platform-fit caption + hashtags for one post. Short-form
        // platforms (X/Threads) get generated.captionShort (or a derived trim), clamped to the limit;
        // long-form platforms get the full caption. Credit line (stock attribution) rides after the footer.
        const captionFor = (plat: string, creditSuffix = '') => fitForPlatform({
            platform: plat,
            longCaption: rawCaption,
            shortCaption: generated.captionShort,
            hashtagsRaw: generated.hashtags,
            footer: disclosureFooter,
            creditSuffix,
            brand: brandHashtags,
        });
        const primaryFit = captionFor(platform);

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
            caption: primaryFit.caption || null,
            hashtags: primaryFit.hashtags || null,
            suggestedMediaDescription: reelBrief || null,
            conflictNotice: generated.conflictNotice || null,
            status: isAdminTest ? 'admin_test' : 'pending_approval',
            generatedAt: now,
            triggerType: job.trigger_type ?? 'scheduled',
            // Siblings of one autopilot cross-post share the group id stamped at enqueue time, so the
            // Review Queue collapses them into a single card. Null ⇒ standalone (single-platform slot).
            crosspostGroupId: job.crosspost_group_id,
        }).returning({ id: scheduledPosts.id });

        // Link the already-claimed idea (status was flipped to 'in_review' when we claimed it above)
        // to the draft it produced (best-effort). The idea now rides with this draft through the
        // Review Queue; approve-post.ts flips it to 'delivered' once approved, closing the loop.
        if (consumedIdeaId) {
            await db.execute(
                `UPDATE post_idea_suggestions SET used_post_id = ${post.id}
                 WHERE id = ${consumedIdeaId}`
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
                sourceCaption: primaryFit.caption || null,
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
        // Which source actually supplied the image. The Autopilot gate needs it (an AI-generated
        // image can never publish unattended), and it stays null when no media was attached — a
        // media-less post must never auto-publish either.
        let attachedMediaSource: MediaSource | null = null;
        // Stock-attribution credit line for the shared asset (empty unless stock media + org opt-in +
        // a photographer name). Captured here so the fan-out siblings can rebuild their own
        // platform-fit captions WITH the same credit, rather than copying the primary's caption.
        let stockCreditSuffix = '';
        // Set when the Autopilot gate promoted this draft straight to 'scheduled'. The user is told
        // what was scheduled on their behalf, not asked to review something that already left.
        let autoPublished = false;
        try {
            // Two contexts, deliberately different: the AI generator gets the full art-direction brief
            // (suggestedMediaDescription), but stock SEARCH gets the literal, photographable subject
            // (imageSearchQuery). A brief like "split graphic, 41 days crossed out, logo" produced a
            // wrong/contradictory stock photo when it was used as the search text; the plain subject
            // query keyword-matches something that actually fits the post.
            const aiMediaContext = (generated.suggestedMediaDescription || rawCaption || '').trim();
            const stockContext = (generated.imageSearchQuery || generated.suggestedMediaDescription || rawCaption || '').trim();
            if (aiMediaContext) {
                const [asst] = await db.select({ mediaSources: aiAssistants.mediaSources })
                    .from(aiAssistants).where(eq(aiAssistants.id, job.assistant_id)).limit(1);

                // AI-image source: charged against the org's STANDARD AI-credit balance (not the
                // autonomous cap). holdCredits refuses when the balance is short — the throw makes the
                // resolver treat AI as unavailable and fall through (or report exhausted → no media).
                // Only fires for image posts: the resolver skips 'ai' for video (async gen path).
                const aspect = format === 'story' ? '9:16' : platformFormat(platform).aspectRatio;
                const generateAi = async (): Promise<number> => {
                    const hold = await holdCredits(db, { orgId: job.organisation_id, amount: IMAGE_CREDIT_COST });
                    if (!hold.ok) throw new Error('insufficient_ai_credits');

                    const [genJob] = await db.insert(mediaGenerationJobs).values({
                        organisationId: job.organisation_id, userId: job.user_id, assistantId: job.assistant_id,
                        mediaType: 'image', prompt: aiMediaContext, aspectRatio: aspect,
                        model: AI_IMAGE_MODEL, creditCost: IMAGE_CREDIT_COST, isAutonomous: false, status: 'processing',
                    }).returning({ id: mediaGenerationJobs.id });

                    try {
                        const assetId = await generateAndPersistImage(db, {
                            orgId: job.organisation_id, userId: job.user_id,
                            prompt: aiMediaContext, aspectRatio: aspect, generationJobId: genJob.id,
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

                // Brand card: the org's own typography instead of a photograph. Free (no AI credits,
                // no provider call) and deterministic, so unlike generateAi there is nothing to hold
                // or refund — the only way it fails is a missing headline or unconfigured R2, both of
                // which throw and drop through to the next source.
                const renderCard = async (): Promise<number> => {
                    const headline = (generated.cardHeadline || '').trim() || headlineFromCaption(rawCaption) || '';
                    if (!headline) throw new Error('no_card_headline');

                    // Derives the kit from the org's own website the first time a card is needed
                    // (and persists it), so a client who never filled in a brand form still gets
                    // their own colours. Falls back to the neutral default and never throws.
                    const [kit, [org]] = await Promise.all([
                        resolveBrandKitForOrg(db, job.organisation_id, now),
                        db.select({ name: organisations.name })
                            .from(organisations).where(eq(organisations.id, job.organisation_id)).limit(1),
                    ]);

                    return renderAndPersistBrandCard(db, {
                        orgId: job.organisation_id, userId: job.user_id,
                        headline, kit, aspectRatio: aspect,
                        // Post id seeds the light/bold polarity, so consecutive posts alternate and a
                        // retry of THIS post re-renders the same card.
                        seed: post.id, orgName: org?.name ?? null,
                    });
                };

                const resolved = await resolveMediaForPost(db, {
                    assistant: { mediaSources: asst?.mediaSources },
                    orgId: job.organisation_id,
                    userId: job.user_id,
                    // Stock keywords come from the literal subject; AI generation uses the full brief
                    // captured inside generateAi. context feeds only the stock path (see media-resolver).
                    context: stockContext,
                    mediaType: isVideo ? 'video' : 'image',
                    generateAi,
                    renderBrandCard: renderCard,
                    // Alternates stock ↔ brand_card when both are enabled, so the feed mixes photos
                    // and cards rather than the higher-priority source winning every single time.
                    rotationKey: post.id,
                });
                if (resolved.ok) {
                    await attachAssetToPost(db, post.id, resolved.assetId);
                    attachedMediaSource = resolved.source;
                    // US3 AC3.3: credit line only for stock (Pexels) media, and only when the org opts in.
                    // Rebuild through captionFor so the credit rides after the footer on the correct
                    // platform-fit caption (short-form posts keep their trimmed body, not the long one).
                    if (resolved.source === 'stock' && rawCaption) {
                        const [org] = await db.select({ enabled: organisations.pexelsAttributionEnabled })
                            .from(organisations).where(eq(organisations.id, job.organisation_id)).limit(1);
                        if (org?.enabled) {
                            const [creditAsset] = await db.select({ photographer: contentAssets.attributionName })
                                .from(contentAssets).where(eq(contentAssets.id, resolved.assetId)).limit(1);
                            if (creditAsset?.photographer) {
                                stockCreditSuffix = creditLine(creditAsset.photographer);
                                await db.update(scheduledPosts)
                                    .set({ caption: captionFor(platform, stockCreditSuffix).caption, updatedAt: now })
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

        // ── Autopilot: publish mode ───────────────────────────────────────────────────────────
        // The post above was inserted as 'pending_approval'. This block can only PROMOTE it to
        // 'scheduled'; it never demotes, so every failure — a thrown query, a missing assistant, an
        // absent media source — leaves the draft safely in the review queue.
        //
        // It runs here, after media resolution, rather than at the insert: the gate refuses to
        // auto-publish an AI-generated image, and the media source doesn't exist until now.
        // Admin-test drafts (status 'admin_test') are never real posts and are excluded.
        if (!isAdminTest && attachedMediaSource) {
            autoPublished = await runAutoPublishGate(db, {
                postId: post.id, platform, assistantId: job.assistant_id, organisationId: job.organisation_id,
                caption: captionFor(platform, stockCreditSuffix).caption, mediaSource: attachedMediaSource, now,
            });
        }

        // One-idea fan-out: clone the finished primary post onto the remaining platforms. The idea,
        // media, format, slot and crosspost_group_id are shared, but each sibling gets its OWN
        // platform-fit caption + hashtags (X/Threads a short variant + trimmed tags, long-form the full
        // caption) via captionFor — no longer a verbatim copy of the primary's caption. Each then runs
        // its own auto-publish gate (connection/policy/confidence are per platform).
        if (fanOut && !isAdminTest) {
            try {
                const [primary] = await db.select({
                    suggestedMediaDescription: scheduledPosts.suggestedMediaDescription,
                    pillar: scheduledPosts.pillar, postFormat: scheduledPosts.postFormat,
                    publishDate: scheduledPosts.publishDate, contentAssetIds: scheduledPosts.contentAssetIds,
                    crosspostGroupId: scheduledPosts.crosspostGroupId,
                }).from(scheduledPosts).where(eq(scheduledPosts.id, post.id)).limit(1);
                const sharedAssetIds = Array.isArray(primary?.contentAssetIds) ? (primary!.contentAssetIds as number[]) : [];

                // Per-sibling, not per-fan-out. One platform failing used to abort the loop and take
                // every platform AFTER it with it — so a cross-post aimed at four accounts could
                // land on two, look like a deliberate two-platform post in the Review Queue, and say
                // nothing. Each sibling now stands or falls on its own.
                const made: string[] = [];
                const failed: string[] = [];
                for (const siblingPlatform of targetPlatforms.slice(1)) {
                    try {
                        const siblingFit = captionFor(siblingPlatform, stockCreditSuffix);
                        const [sibling] = await db.insert(scheduledPosts).values({
                            userId: job.user_id, organisationId: job.organisation_id, assistantId: job.assistant_id,
                            blueprintId: job.blueprint_id, jobId: job.job_id,
                            platform: siblingPlatform, postFormat: primary?.postFormat ?? format, pillar: primary?.pillar ?? null,
                            publishDate: primary?.publishDate ?? new Date(now.getTime() + 24 * 60 * 60 * 1000),
                            caption: siblingFit.caption || null, hashtags: siblingFit.hashtags || null,
                            suggestedMediaDescription: primary?.suggestedMediaDescription ?? null,
                            status: 'pending_approval', generatedAt: now, triggerType: job.trigger_type ?? 'scheduled',
                            crosspostGroupId: primary?.crosspostGroupId ?? job.crosspost_group_id,
                        }).returning({ id: scheduledPosts.id });

                        for (const aid of sharedAssetIds) await attachAssetToPost(db, sibling.id, aid);

                        if (attachedMediaSource) {
                            await runAutoPublishGate(db, {
                                postId: sibling.id, platform: siblingPlatform, assistantId: job.assistant_id,
                                organisationId: job.organisation_id, caption: siblingFit.caption,
                                mediaSource: attachedMediaSource, now,
                            });
                        }
                        made.push(siblingPlatform);
                    } catch (sibErr) {
                        failed.push(siblingPlatform);
                        console.error(`[process-content-jobs] job ${job.job_id} sibling ${siblingPlatform} failed:`,
                            sibErr instanceof Error ? sibErr.message : sibErr);
                    }
                }
                // Say plainly that the group is short. A partial cross-post is indistinguishable from
                // an intentionally narrow one once it is in the queue, so the log is the only place
                // the discrepancy can be seen at all.
                if (failed.length) {
                    console.error(`[process-content-jobs] job ${job.job_id} PARTIAL cross-post: `
                        + `asked for ${targetPlatforms.join(',')} — created ${[targetPlatforms[0], ...made].join(',')}, `
                        + `missing ${failed.join(',')}`);
                }
            } catch (fanErr) {
                // A fan-out failure must not fail the job — the primary post is already safely drafted.
                console.error(`[process-content-jobs] job ${job.job_id} fan-out to sibling platforms failed:`, fanErr instanceof Error ? fanErr.message : fanErr);
            }
        }

        // Quality review at DRAFT time, once per slot, copied to the cross-post siblings.
        // Previously the review only ran when someone opened the post in the calendar panel, so the
        // Review Queue — the primary approval surface — showed no warnings, no suggestions and no
        // score, and approve-post had nothing to enforce its compliance gate against. Running it
        // here means the human sees the verdict at the moment they're asked to approve.
        // Best-effort by construction: reviewDraftGroup swallows its own failures.
        if (!isAdminTest) {
            const hasQualityReviewFeature = await hasFeatureByOrg(db, job.organisation_id, 'quality_reviewer')
                .catch(() => false);
            await reviewDraftGroup(db, {
                postId: post.id,
                organisationId: job.organisation_id,
                hasQualityReviewFeature,
            });
        }

        // Includes the near-duplicate re-ask when one fired (0 otherwise), so the job's recorded
        // cost is what it actually spent — a second generation billed as free would make the
        // gate's real cost invisible in exactly the reporting used to judge whether to keep it.
        const tokenCols = tokensInput != null
            ? `, tokens_input = ${tokensInput + dupTokensIn}, tokens_output = ${(tokensOutput ?? 0) + dupTokensOut}`
            : '';
        await db.execute(
            `UPDATE content_generation_jobs SET status = 'completed', result_post_id = ${post.id}${tokenCols}, updated_at = now() WHERE id = ${job.id}`
        );

        // Admin test jobs do not notify the consumer
        if (!isAdminTest) {
            const [asst] = await db.select({ name: aiAssistants.name }).from(aiAssistants).where(eq(aiAssistants.id, job.assistant_id)).limit(1);
            const assistantLabel = asst?.name ?? 'Your assistant';
            const cap = (p: string) => p.charAt(0).toUpperCase() + p.slice(1);
            // One notification for the whole cross-post; the label names every platform it fanned to.
            const platformLabel = fanOut ? targetPlatforms.map(cap).join(', ') : cap(platform);

            if (autoPublished) {
                // Nothing to review — it's already scheduled. Point at the calendar, where the user
                // can still change or cancel it before its publish date arrives.
                await createNotification(db, 'ai_auto_publish_post', {
                    userId: job.user_id,
                    context: { assistant: { name: assistantLabel }, platform: { label: platformLabel } },
                    metadata: { jobId: job.job_id, postId: post.id, reason: 'auto_publish', assistantId: job.assistant_id },
                });
            } else if (mediaExhaustedReason) {
                // The draft is ready but has no media. Send ONE actionable notice instead of the generic
                // "draft ready", flagging the AI-credit case explicitly so the fix (top up) is obvious.
                const outOfCredits = mediaExhaustedReason === 'ai_credits_exhausted';
                await createNotification(db, outOfCredits ? 'draft_ready_no_credits' : 'draft_ready_no_media', {
                    userId: job.user_id,
                    context: { assistant: { name: assistantLabel }, platform: { label: platformLabel } },
                    metadata: { jobId: job.job_id, postId: post.id, reason: mediaExhaustedReason, assistantId: job.assistant_id },
                });
            } else {
                await createNotification(db, job.trigger_type === 'on_demand' ? 'post_draft_ready_on_demand' : 'post_draft_ready', {
                    userId: job.user_id,
                    context: { assistant: { name: assistantLabel }, platform: { label: platformLabel } },
                    metadata: { jobId: job.job_id, postId: post.id, assistantId: job.assistant_id },
                });
            }
        }

    } catch (err) {
        const attempt = job.attempt + 1;
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error(`[process-content-jobs] job ${job.job_id} attempt ${attempt} failed:`, errorMessage);

        // Release the idea we claimed up-front so this failure doesn't strand it in 'in_review'
        // forever — back to 'pending' (only if it never produced a post) so a retry can reclaim it.
        if (consumedIdeaId) {
            await db.execute(
                `UPDATE post_idea_suggestions SET status = 'pending', used_at = NULL
                 WHERE id = ${consumedIdeaId} AND used_post_id IS NULL`
            ).catch(() => {});
        }

        if (attempt >= job.max_attempts) {
            await db.execute(
                `UPDATE content_generation_jobs SET status = 'failed', error_message = '${errorMessage.replace(/'/g, "''")}', updated_at = now() WHERE id = ${job.id}`
            );
            await createNotification(db, 'post_generation_failed', {
                userId: job.user_id,
                metadata: { jobId: job.job_id, error: errorMessage, assistantId: job.assistant_id },
            });
            await db.insert(auditLogs).values({ actionType: 'post_generation_failed', resourceType: 'content_generation_jobs', resourceId: job.job_id, userId: job.user_id, newState: { errorMessage, attempt } });
        } else {
            const backoffSecs = BACKOFF_SECS[attempt - 1] ?? 90;
            const nextRetryAt = new Date(Date.now() + backoffSecs * 1000).toISOString();
            await db.execute(
                `UPDATE content_generation_jobs SET status = 'queued', next_retry_at = '${nextRetryAt}', error_message = '${errorMessage.replace(/'/g, "''")}', updated_at = now() WHERE id = ${job.id}`
            );

            // Tell the human their post is retrying rather than hung. Before this, the only
            // notification was "Generating your post…" at enqueue, so a failed-and-retrying job was
            // indistinguishable from a stuck one — which is exactly how it got reported.
            //
            // Only for work someone asked for, and only on the FIRST retry: per-attempt pings would
            // be three notifications for one post. Best-effort — a notification failure must never
            // turn a retryable job into a lost one.
            if (attempt === 1 && job.trigger_type === 'on_demand') {
                await createNotification(db, 'post_generation_retrying', {
                    userId: job.user_id,
                    metadata: { jobId: job.job_id, assistantId: job.assistant_id, error: errorMessage },
                }).catch(() => {});
            }
        }
    }
}

// Autopilot publish gate for a single drafted post. Can only PROMOTE 'pending_approval' → 'scheduled'
// (never demote); every failure leaves the draft safely in review. Runs per platform — connection,
// policy and confidence are platform-specific — so the primary post and each fanned-out sibling each
// call it with their own platform. Returns whether the post was auto-published. Never throws.
async function runAutoPublishGate(db: ReturnType<typeof getDb>, args: {
    postId: number; platform: string; assistantId: number; organisationId: number;
    caption: string; mediaSource: MediaSource; now: Date;
}): Promise<boolean> {
    try {
        const [asst] = await db.select({ onboardingContext: aiAssistants.onboardingContext })
            .from(aiAssistants).where(eq(aiAssistants.id, args.assistantId)).limit(1);

        const decision = await decideAutoPublish(db, {
            assistantId: args.assistantId,
            organisationId: args.organisationId,
            platform: args.platform,
            caption: args.caption,
            mediaSource: args.mediaSource,
            onboardingContext: asst?.onboardingContext ?? null,
            now: args.now,
        });

        // Stamp the connection on every draft, published or not: a human-approved post needs it too,
        // and publish-instagram.ts hard-fails without it.
        const patch: Record<string, unknown> = { connectionId: decision.connectionId, updatedAt: args.now };

        if (decision.confidence) {
            patch.confidenceScore = decision.confidence.confidenceScore;
            patch.factualClaimsCount = decision.confidence.factualClaimsCount;
            patch.factualClaims = decision.confidence.factualClaims;
            patch.confidenceAssessedAt = args.now;
            patch.confidenceAssessmentMs = decision.confidence.assessmentDurationMs;
        }

        let autoPublished = false;
        if (decision.status === 'scheduled') {
            patch.status = 'scheduled';
            patch.autoPublishedAt = args.now;   // marks it unattended + counts toward the weekly ceiling
            autoPublished = true;
        }

        // Only explain the routing when the deployer actually turned publish mode on — otherwise every
        // draft in the product would carry a redundant "sent for review" note.
        if (decision.reason !== 'platform_in_review_mode') {
            patch.generationReason = describeDecision(decision);
        }

        await db.update(scheduledPosts).set(patch).where(eq(scheduledPosts.id, args.postId));

        if (decision.reason === 'weekly_cap_reached') {
            console.warn(`[process-content-jobs] assistant ${args.assistantId} hit its weekly auto-publish ceiling — post ${args.postId} routed to review.`);
        }
        return autoPublished;
    } catch (gateErr) {
        // A broken gate must not publish and must not fail the job: the draft stays in review.
        console.error(`[process-content-jobs] auto-publish gate failed for post ${args.postId} (left in review):`, gateErr instanceof Error ? gateErr.message : gateErr);
        return false;
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
