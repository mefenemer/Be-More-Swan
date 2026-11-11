// src/utils/video-render.ts
//
// Render a Video Producer PROJECT to My Content (docs/video-producer-studio-plan.md §4.1).
//
// The Video Producer is a studio: a finished video is a content_asset, not a post. The build saves the
// timeline on the project (video_projects.timeline — clips, on-screen text, voiceover / caption tracks)
// and this renders it through the SAME Remotion composition and the same resolvers the post renders use
// (src/lib/post-render.ts), so captions, stills, trims and gains behave identically. The post render
// path (post_render_jobs, render-post-video-background) is not touched.
//
//   rendering → ready          output_asset_id = the MP4 in My Content
//             ↘ render_failed  note says why; "Try the render again" re-queues it (video-projects 'rerender')
//
// Called by netlify/functions/render-video-project-background.ts (15-minute ceiling). Every exit leaves
// the project terminal or still 'rendering' with a render in flight; the stuck sweep (video-producer.ts)
// turns a dead one into render_failed after 20 minutes. Never charges: the build already settled.

import { isRealisticStyle } from '../lib/ai-clip';
import { and, eq, isNull } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { contentAssets, videoProjects } from '../../db/schema';
import { presignR2Get } from './social-publish';
import { persistRemoteMediaToR2, r2IsConfigured } from '../lib/media-persist';
import { RENDER_FPS, renderableOverlays, resolveAudioTracks, resolveCaptionTrack, resolveEditClips, shouldRetryRender, type VideoBase } from '../lib/post-render';
import { remotionConfigured, renderProgress, startRender, type StartedRender } from '../lib/remotion-lambda';
import { recordPlatformIncident } from './platform-incident';
import type { ProjectTimeline } from './video-producer';
import { SOURCE_POST_NOTES, attachVideoToSourcePost, placeVideoOnCampaignPost } from './video-post-media';
import type { Storyboard } from '../lib/storyboard';

type Db = ReturnType<typeof getDb>;

const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 12 * 60 * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The name the finished video has in My Content: its title, and the version after the first. Pure. */
export function outputName(title: string, version: number): string {
    const t = (title || 'Video').replace(/\s+/g, ' ').trim().slice(0, 70);
    return version > 1 ? `${t} (version ${version})` : t;
}

/** Does this storyboard use AI for any scene? Shown as "Contains AI" (owner decision D-S6). Pure. */
export function containsAi(sb: Storyboard | null): boolean {
    return !!sb?.scenes.some((s) => s.source === 'ai_video' || s.source === 'ai_image');
}

/**
 * Does it contain AI that looks real? An AI clip on its own in the 3D animated or 2D cartoon style doesn't;
 * every other AI scene does. What the "Made with AI" caption line reads (ai-disclosure.ts). Pure.
 */
export function containsRealisticAi(sb: Storyboard | null, brief: { clip?: { style?: string } | null } | null): boolean {
    return containsAi(sb) && !(brief?.clip && !isRealisticStyle(brief.clip.style));
}

export async function renderProject(db: Db, projectId: number): Promise<void> {
    const [p] = await db.select().from(videoProjects).where(eq(videoProjects.id, projectId)).limit(1);
    if (!p || p.status !== 'rendering' || !p.timeline) return;
    // The claim: the render id is set once, so a duplicate wake does not start a second render.
    const claimed = await db.update(videoProjects).set({ renderId: 'starting', updatedAt: new Date() })
        .where(and(eq(videoProjects.id, projectId), eq(videoProjects.status, 'rendering'), isNull(videoProjects.renderId)))
        .returning({ id: videoProjects.id });
    if (!claimed.length) return;

    const orgId = p.organisationId;
    const fail = async (note: string, err?: unknown) => {
        if (err) await recordPlatformIncident(db, { kind: 'video_build', error: err, organisationId: orgId, assistantId: p.aiAssistantId, role: 'video_producer', view: 'video-producer', ids: { projectId } }).catch(() => {});
        await db.update(videoProjects).set({ status: 'render_failed', renderId: null, note: note.slice(0, 400), updatedAt: new Date() })
            .where(eq(videoProjects.id, projectId));
    };

    try {
        if (p.createdBy == null) return await fail('The person who made this video no longer has an account.');
        if (!remotionConfigured()) return await fail('Video rendering is not set up in this environment.');
        if (!r2IsConfigured()) return await fail('Storage is not set up, so the finished video has nowhere to go.');
        const tl = p.timeline as ProjectTimeline;
        const clips = tl.videoEdit?.clips ?? [];
        if (!clips.length) return await fail('This video has no scenes to render. Make it again.');

        // The composition still wants a "base": the first clip's asset (its kind decides video vs still).
        const [first] = await db.select({ id: contentAssets.id, storageKey: contentAssets.storageKey, externalUrl: contentAssets.externalUrl, mimeType: contentAssets.mimeType, width: contentAssets.width, height: contentAssets.height, assetType: contentAssets.assetType })
            .from(contentAssets).where(and(eq(contentAssets.id, clips[0].assetId), eq(contentAssets.organisationId, orgId))).limit(1);
        if (!first) return await fail('A scene’s picture or clip is missing. Make the video again.');
        const base: VideoBase = {
            assetId: first.id, storageKey: first.storageKey, externalUrl: first.externalUrl,
            mimeType: first.mimeType ?? 'video/mp4', width: first.width, height: first.height,
            kind: (first.assetType ?? '').toLowerCase() === 'image' ? 'image' : 'video',
        };
        const audio = await resolveAudioTracks(db, tl.audio, orgId, presignR2Get);
        const captions = audio.length ? await resolveCaptionTrack(db, tl.audio, orgId).catch(() => null) : null;
        const timeline = await resolveEditClips(db, { videoEdit: tl.videoEdit, orgId, base, hasTimelineAudio: audio.length > 0 }, presignR2Get);
        if (!timeline.length) return await fail('The scenes couldn’t be read. Make the video again.');
        const fps = RENDER_FPS;
        const props = {
            videoSrc: timeline[0].kind !== 'image' ? timeline[0].src : '',
            clips: timeline,
            targetRatio: tl.targetRatio || '9:16',
            audio,
            overlays: renderableOverlays(tl.overlays),
            ...(captions ? { captions } : {}),
            // The colour look (src/lib/video-look.ts); an older bundle ignores it and renders ungraded.
            ...(tl.look ? { look: tl.look } : {}),
            width: tl.width || 1080,
            height: tl.height || 1920,
            fps,
            durationInFrames: Math.max(1, Math.round(Math.min(600, tl.durationS || 15) * fps)),
        };

        let started: StartedRender = await startRender(props);
        await db.update(videoProjects).set({ renderId: started.renderId, renderBucket: started.bucketName, renderRegion: started.region, updatedAt: new Date() })
            .where(eq(videoProjects.id, projectId));
        const deadline = Date.now() + POLL_TIMEOUT_MS;
        let outputUrl: string | null = null;
        let retried = false;
        while (true) {
            const progress = await renderProgress(started);
            if (progress.error && shouldRetryRender(progress.error, retried, deadline - Date.now())) {
                retried = true;
                started = await startRender(props);
                await db.update(videoProjects).set({ renderId: started.renderId, renderBucket: started.bucketName, renderRegion: started.region, updatedAt: new Date() })
                    .where(eq(videoProjects.id, projectId));
                continue;
            }
            if (progress.error) return await fail(renderFailureNote(progress.error), new Error(progress.error));
            if (progress.done) {
                if (!progress.outputUrl) return await fail('The render finished but produced no file. Try the render again.');
                outputUrl = progress.outputUrl;
                break;
            }
            if (Date.now() > deadline) return await fail('The finished video took too long to render. Try the render again.');
            // Keeps the project "fresh" for the stuck sweep while a long render is genuinely running.
            await db.update(videoProjects).set({ updatedAt: new Date() }).where(eq(videoProjects.id, projectId));
            await sleep(POLL_INTERVAL_MS);
        }

        const stored = await persistRemoteMediaToR2({ orgId, url: outputUrl, contentType: 'video/mp4', folder: 'video-producer', label: 'finished video' });
        const sb = p.storyboard as Storyboard | null;
        const [asset] = await db.insert(contentAssets).values({
            userId: p.createdBy, organisationId: orgId, name: outputName(p.title, p.version),
            assetType: 'video', mimeType: 'video/mp4', fileSize: stored.fileSize, storageKey: stored.storageKey,
            width: props.width, height: props.height, durationS: Math.round((props.durationInFrames / fps) * 100) / 100,
            aspectRatio: props.targetRatio, provider: 'video_producer',
            // What My Content and the hand-offs read: who made it, which project, and "Contains AI".
            // sourceAssetIds: the files this version was made from, kept with it (listed on the Videos tab).
            renderParams: { kind: 'video_producer', projectId, version: p.version, containsAi: containsAi(sb), containsRealisticAi: containsRealisticAi(sb, p.brief as { clip?: { style?: string } | null } | null), suggestedWords: sb?.caption ?? null, sourceAssetIds: tl.sourceAssetIds ?? [] },
            status: 'pending',
        }).returning({ id: contentAssets.id });
        // Made FOR a post — "Make a video version", or a campaign — it goes back to it (Phase 5, D-S4).
        // The note says where it went; the video is in My Content whatever happens.
        let note: string | null = null;
        const shape = (p.brief as { shape?: string } | null)?.shape ?? '9:16';
        if (p.sourcePostId) {
            note = SOURCE_POST_NOTES[await attachVideoToSourcePost(db, { orgId, userId: p.createdBy, postId: p.sourcePostId, assetId: asset.id, shape })];
        } else if (p.campaignId) {
            note = await placeVideoOnCampaignPost(db, { orgId, campaignId: p.campaignId, assetId: asset.id, shape })
                ? 'Sent back to the campaign that asked for it. It’s also in My Content.'
                : null;
        }
        await db.update(videoProjects).set({ status: 'ready', outputAssetId: asset.id, renderId: null, note, updatedAt: new Date() })
            .where(eq(videoProjects.id, projectId));
    } catch (err) {
        console.error(`[video-render] project ${projectId} failed:`, err);
        await fail('The finished video couldn’t be rendered. Try the render again.', err).catch(() => {});
    }
}

/**
 * What the owner reads when a render fails. Remotion's errors carry signed file links — a long
 * unbreakable URL that ran out of the box on the Videos tab (2026-11-10) and means nothing to the
 * owner. Links come out; a download failure says which kind of file. The full error is in the log. Pure.
 */
export function renderFailureNote(error: string): string {
    const kind = /error while downloading[^]*?\/library\/music\//i.test(error) ? 'the music'
        : /error while downloading[^]*?\.(mp3|wav|m4a|aac)\b/i.test(error) ? 'one of its sound files'
        : /error while downloading/i.test(error) ? 'one of its files' : null;
    if (kind) return `The finished video couldn’t be rendered: ${kind} couldn’t be downloaded. Change it, or try the render again.`;
    const plain = error.replace(/https?:\/\/\S+/g, '(a file)').replace(/\s+/g, ' ').trim();
    return `The finished video couldn’t be rendered: ${plain.slice(0, 200)}`;
}
