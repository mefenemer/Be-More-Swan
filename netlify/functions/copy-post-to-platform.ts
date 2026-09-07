// netlify/functions/copy-post-to-platform.ts
// Send a post that has ALREADY GONE OUT to another platform, as a fresh draft.
//
// POST { postId, destinations: [{ platform, formatKey }] }   (or the legacy { platforms: [...] })
//   → { copies: [{ id, platform, formatKey, captionReworded }], skipped: [{ platform, reason }] }
//   Auth: aura_session (requireTenant). The source post must belong to the caller's org.
//
// ── Why this is not set-post-platforms ──────────────────────────────────────────────────────────
// That endpoint edits WHERE A DRAFT GOES, and refuses anything past 'in_review' on purpose: an
// approved or published row is a commitment, and letting the platform picker delete one would be a
// way to lose committed work with no undo. It is also the wrong SHAPE for this. Its new rows join
// the anchor's crosspost group — one post, several places, one slot — and the Review Queue groups by
// (crosspost_group_id, status). A pending copy dropped into a published post's group would land on
// the same card as the post that has already gone out, and every media write on that card would try
// to fan out across a published row.
//
// So a copy is a genuinely NEW post: its own group, its own slot, its own review. It records where
// it came from in copied_from_post_id (db/post-copied-from.sql) — which is what lets the editor say
// "already sent to LinkedIn" and refuse to make the same copy twice.
//
// ── What it deliberately does not do ────────────────────────────────────────────────────────────
// It never publishes. The copy lands in the Review Queue as 'pending_approval' like any other draft,
// because the platforms differ in ways only a human should sign off: a caption written for Instagram
// reads differently on LinkedIn, and the picture may be the wrong shape. Approval is the existing
// pipeline's job and every gate it applies (connections, mandatory media, compliance) still applies.

import { and, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../../db/client';
import { scheduledPosts, scheduledPostAssets, contentAssets, aiAssistants } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { parseDestinations, destinationKey, canonicalPlatform, legacyPostFormat } from '../../src/utils/post-destinations';
import { platformFormat } from '../../src/config/platform-formats';
import { resolvePostingSchedule, computeScheduleSlots, resolveHorizonDays } from '../../src/config/posting-cadence';
import { consumeTaskCredit } from '../../src/utils/task-credit';
import { isGlobalAiDisabled } from '../../src/utils/platform-config';
import { logAiUsage } from '../../src/utils/ai-usage';
import { displayCaption, stripCodeFences } from '../../src/utils/model-json';
import { currentDatePromptBlock } from '../../src/utils/current-date-prompt';
import { withLambda } from '@netlify/aws-lambda-compat';

const MODEL = 'claude-haiku-4-5-20251001';

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

/** Only a post that has actually gone out can be copied onward. */
const COPYABLE = ['published'];

/** How many destinations one request may create. A guard against a malformed client, not a policy. */
const MAX_DESTINATIONS = 8;

/**
 * Shorten a caption to fit a platform that will not take it, keeping the message.
 *
 * Called ONLY when the caption genuinely does not fit — Instagram's 2,200 characters against X's
 * 280 is the case this exists for. A copy that fits is copied verbatim, because it is the same post
 * and rewriting the user's words when nothing required it is not an improvement.
 *
 * Returns null on any failure, and the caller then falls back to the original text rather than
 * refusing the copy: an over-long caption is visible and fixable in the Review Queue, whereas no
 * draft at all leaves the user with nothing to fix.
 */
async function fitCaption(args: {
    caption: string; platform: string; limit: number; publishDate: Date | string | null;
    userId: number; orgId: number;
}): Promise<string | null> {
    const { caption, platform, limit, publishDate, userId, orgId } = args;
    try {
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const response = await anthropic.messages.create({
            model: MODEL,
            max_tokens: 1200,
            // Same date-first rule as rewrite-post-text: a rewrite is free to invent a year that was
            // never in the original, and this one rewrites the whole caption.
            system: `${currentDatePromptBlock({ publishDate })}\n\n`
                + 'You adapt ONE social media caption so it fits a different platform. Keep the message, the '
                + 'facts, the language and the voice of the original — this is the SAME post, going somewhere '
                + 'with less room. Do not invent details that are not in the original, and do not add a '
                + 'call to action that was not already there. Return ONLY the replacement caption: no preamble, '
                + 'no explanation, no surrounding quotes, no code fences.',
            messages: [{
                role: 'user',
                content: `Target platform: ${platform} (hard caption limit ${limit} characters)\n`
                    + `Original caption (${caption.length} characters):\n"""${caption.slice(0, 5000)}"""\n\n`
                    + `Task: rewrite it to fit comfortably within ${limit} characters.`,
            }],
        });
        let text = stripCodeFences((response.content[0] as { text?: string })?.text?.trim() ?? '');
        if (!text) return null;

        void logAiUsage({
            userId, workspaceId: orgId, model: MODEL,
            inputTokens: response.usage?.input_tokens ?? 0,
            outputTokens: response.usage?.output_tokens ?? 0,
        });

        // The model can still overshoot. Hard-trim on a word boundary rather than returning
        // something the platform will reject outright — the draft is reviewed before it goes.
        if (text.length > limit) {
            const cut = text.slice(0, limit);
            const lastSpace = cut.lastIndexOf(' ');
            text = (lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
        }
        return text || null;
    } catch (err) {
        console.error('[copy-post-to-platform] caption fit failed:', err);
        return null;
    }
}

/**
 * A sensible proposed slot for the copy — the assistant's next cadence slot, else tomorrow.
 *
 * Only a PROPOSAL. Approving with "let the assistant schedule it" re-picks an optimal slot in
 * approve-post anyway; this exists so the draft shows a plausible date in the queue rather than a
 * date in the past, which the past-schedule gate would then argue with.
 */
async function proposeSlot(db: ReturnType<typeof getDb>, assistantId: number | null, now: Date): Promise<Date> {
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    if (!assistantId) return tomorrow;
    try {
        const [assistant] = await db
            .select({ onboardingContext: aiAssistants.onboardingContext, draftHorizonDays: aiAssistants.draftHorizonDays })
            .from(aiAssistants)
            .where(eq(aiAssistants.id, assistantId))
            .limit(1);
        if (!assistant) return tomorrow;
        const schedule = resolvePostingSchedule((assistant.onboardingContext as Record<string, unknown>) ?? {});
        const slots = computeScheduleSlots({
            schedule,
            horizonDays: Math.max(7, resolveHorizonDays(assistant)),
            now,
        });
        const next = slots.find(s => s.getTime() > now.getTime());
        return next ?? tomorrow;
    } catch {
        return tomorrow;   // an on-demand assistant has no cadence — that is not an error
    }
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId, organisationId: orgId } = ctx;

    let body: { postId?: number; destinations?: unknown; platforms?: unknown };
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Invalid JSON.' }); }

    const postId = Number(body.postId);
    if (!Number.isInteger(postId)) return json(400, { error: 'postId required.' });

    const [source] = await db.select().from(scheduledPosts)
        .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.organisationId, orgId)))
        .limit(1);
    if (!source) return json(404, { error: 'Post not found.' });
    if (!COPYABLE.includes(source.status)) {
        // A draft already has a platform picker; sending it somewhere else is set-post-platforms'
        // job, and doing it here would create a second row nobody asked for.
        return json(409, {
            error: source.status === 'scheduled' || source.status === 'approved'
                ? 'This post has not gone out yet — change its platforms from the post editor instead.'
                : `A post in '${source.status}' state cannot be copied to another platform.`,
        });
    }

    // The format comes from the DESTINATION, never from the source: copying the source's formatKey
    // would put an ig_reel on a LinkedIn row, a format that platform does not have.
    const parsed = parseDestinations(body as any);
    if (parsed.error) return json(422, { error: parsed.error });
    const wanted = parsed.destinations.slice(0, MAX_DESTINATIONS);
    if (!wanted.length) return json(422, { error: 'Choose at least one platform to copy this post to.' });

    // ── Where it has been already ───────────────────────────────────────────────────────────────
    // Two sources of "already there", and they mean different things to the user. The source's own
    // cross-post siblings are platforms this post ALREADY went out on; earlier copies are drafts
    // that are sitting in the queue right now. Both are refused, with the reason said out loud —
    // silently making a second identical draft is how a queue fills with duplicates.
    const siblings = source.crosspostGroupId
        ? await db.select({ platform: scheduledPosts.platform, formatKey: scheduledPosts.formatKey })
            .from(scheduledPosts)
            .where(and(
                eq(scheduledPosts.crosspostGroupId, source.crosspostGroupId),
                eq(scheduledPosts.organisationId, orgId)))
        : [{ platform: source.platform, formatKey: source.formatKey }];
    const priorCopies = await db
        .select({ platform: scheduledPosts.platform, formatKey: scheduledPosts.formatKey, status: scheduledPosts.status })
        .from(scheduledPosts)
        .where(and(
            eq(scheduledPosts.copiedFromPostId, postId),
            eq(scheduledPosts.organisationId, orgId)));

    const wentOutOn = new Set(siblings.filter(s => s.platform).map(s => canonicalPlatform(s.platform!)));
    // A copy that was rejected or cancelled is NOT a reason to refuse a new one — the user threw it
    // away, and refusing would leave them unable to try again with no way to see why.
    const copiedTo = new Set(
        priorCopies
            .filter(c => c.platform && !['rejected', 'cancelled'].includes(c.status))
            .map(c => canonicalPlatform(c.platform!)));

    // ── What the copy is made of ────────────────────────────────────────────────────────────────
    // The CLEAN picture, not the published one. A post with text on its image has the flattened copy
    // attached — the words are pixels in it — so seeding from content_asset_ids would give the new
    // platform an image with the text burnt in AND the same design as an editable layer, which is
    // the same double-text bug set-post-platforms had. overlay_base_asset_id is the pre-bake
    // original; it travels with the design so the copy's own bake has something to composite onto.
    const sourceAssetIds = Array.isArray(source.contentAssetIds) ? source.contentAssetIds as number[] : [];
    const baseAssetId = source.overlayBaseAssetId ?? null;
    const copyAssetIds = (baseAssetId != null && sourceAssetIds.length === 1 && sourceAssetIds[0] !== baseAssetId)
        ? [baseAssetId]
        : sourceAssetIds;

    // Is what we are copying a video? Read from the assets rather than from post_format, which is a
    // loose descriptor and is wrong on exactly the posts that matter (a clip on a plain feed post).
    let copyIsVideo = false;
    if (copyAssetIds.length) {
        const kinds = await db
            .select({ assetType: contentAssets.assetType })
            .from(contentAssets)
            .where(and(inArray(contentAssets.id, copyAssetIds), eq(contentAssets.organisationId, orgId)));
        copyIsVideo = kinds.some(k => k.assetType === 'video');
    }

    const caption = displayCaption(source.caption) || '';
    const now = new Date();
    const publishDate = await proposeSlot(db, source.assistantId, now);
    const aiOff = await isGlobalAiDisabled().catch(() => false);

    const copies: Array<{ id: number; platform: string; formatKey: string | null; captionReworded: boolean }> = [];
    const skipped: Array<{ platform: string; reason: string }> = [];
    const seen = new Set<string>();

    for (const dest of wanted) {
        const platform = canonicalPlatform(dest.platform);
        const spec = platformFormat(platform);
        const label = spec.label || platform;

        if (seen.has(destinationKey({ platform, formatKey: dest.formatKey }))) continue;
        seen.add(destinationKey({ platform, formatKey: dest.formatKey }));

        if (wentOutOn.has(platform)) { skipped.push({ platform, reason: `This post already went out on ${label}.` }); continue; }
        if (copiedTo.has(platform)) { skipped.push({ platform, reason: `A ${label} copy of this post is already in your Review Queue.` }); continue; }
        // Refused rather than created: the publishers take an image or nothing, so a video post
        // copied to a platform that cannot carry one would go out as a bare caption.
        if (copyIsVideo && !spec.canPublishVideo) { skipped.push({ platform, reason: `${label} cannot publish video.` }); continue; }
        if (spec.mediaMandatory && !copyAssetIds.length) { skipped.push({ platform, reason: `${label} needs a picture, and this post has none.` }); continue; }

        // ── The caption ─────────────────────────────────────────────────────────────────────────
        // Copied verbatim when it fits, which is the common case and matches how set-post-platforms
        // seeds a new cross-post sibling. The assistant is asked to shorten it ONLY when the target
        // platform would reject it outright — Instagram's 2,200 characters against X's 280 — and
        // that is the only path that spends a task credit.
        const limit = spec.charLimit ?? 2200;
        let finalCaption = caption;
        let captionReworded = false;
        if (caption.length > limit) {
            if (aiOff) {
                // No rewrite available. Copy it anyway rather than refusing — an over-long caption is
                // visible in the editor and the user can cut it themselves.
                console.warn(`[copy-post-to-platform] AI disabled; copying an over-length caption to ${platform}`);
            } else {
                const credit = await consumeTaskCredit(db, orgId);
                if (!credit.allowed) {
                    skipped.push({
                        platform,
                        reason: `This caption is too long for ${label} and shortening it needs a task credit — ${credit.limitMessage}`,
                    });
                    continue;
                }
                const fitted = await fitCaption({
                    caption, platform, limit, publishDate, userId, orgId,
                });
                if (fitted) { finalCaption = fitted; captionReworded = true; }
            }
        }

        const [made] = await db.insert(scheduledPosts).values({
            userId,
            organisationId: orgId,
            assistantId: source.assistantId,
            platform,
            formatKey: dest.formatKey,
            postFormat: dest.formatKey
                ? legacyPostFormat(dest, copyAssetIds.length > 0)
                : (copyIsVideo ? 'video' : (copyAssetIds.length ? 'image' : 'text')),
            publishDate,
            caption: finalCaption,
            hashtags: source.hashtags,
            mentions: source.mentions,
            linkUrl: source.linkUrl,
            ctaText: source.ctaText,
            utmParams: source.utmParams,
            campaign: source.campaign,
            pillar: source.pillar,
            // The user's own disclosure choice travels with the post — re-deciding it per copy would
            // silently re-enable a footer they had turned off.
            disclosureFooterDisabled: source.disclosureFooterDisabled,
            contentAssetIds: copyAssetIds,
            imageOverlays: source.imageOverlays,
            overlayBaseAssetId: baseAssetId,
            audioOverlays: source.audioOverlays,
            // Never inherited: render_status belongs to the SOURCE's render, and a copy that claimed
            // 'done' would publish with no overlaid clip attached at all.
            renderStatus: null,
            status: 'pending_approval',
            triggerType: 'manual',
            isAutonomous: false,
            ownerId: source.ownerId ?? userId,
            ownerLabel: source.ownerLabel,
            generatedAt: now,
            // Its OWN group. One destination is a group of one (null); several copies made in one
            // request are a genuine cross-post of each other and share a new id.
            crosspostGroupId: null,
            copiedFromPostId: postId,
        }).returning({ id: scheduledPosts.id });

        // Mirror the junction rows — scheduled_post_assets is the source of truth for newer queries,
        // and a row with media in the legacy column but no junction rows renders correctly in the
        // editor and then resolves nothing at publish time.
        if (copyAssetIds.length) {
            await db.insert(scheduledPostAssets)
                .values(copyAssetIds.map((contentAssetId, position) => ({
                    scheduledPostId: made.id, contentAssetId, position,
                })))
                .onConflictDoNothing();
        }

        copies.push({ id: made.id, platform, formatKey: dest.formatKey ?? null, captionReworded });
    }

    // Several copies made together ARE a cross-post of one another — they share a caption, a picture
    // and a slot, and the Review Queue should show them as one card with a tab each.
    if (copies.length > 1) {
        const groupId = randomUUID();
        await db.update(scheduledPosts)
            .set({ crosspostGroupId: groupId, updatedAt: now })
            .where(and(inArray(scheduledPosts.id, copies.map(c => c.id)), eq(scheduledPosts.organisationId, orgId)));
    }

    if (!copies.length) {
        return json(422, {
            error: skipped[0]?.reason || 'There was nowhere new to send this post.',
            skipped,
        });
    }

    return json(200, { copies, skipped });
});
