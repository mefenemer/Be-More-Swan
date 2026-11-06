// src/utils/site-draft-media-options.ts — what a workspace may choose for a draft's placeholder media
// and what it costs (site-draft-media.ts). Apart from site-draft-media-run.ts so the Website tab's every
// read, and the chat's snapshot, don't load the Pexels, fal and image-making code the worker needs.

import type { getDb } from '../../db/client';
import { aiVideoTasks } from '../config/task-weights';
import { billedSecondsFor, type VideoDurationSeconds } from '../lib/fal-gateway';
import { tierCanGenerateVideo } from './ai-credits';
import { getOrgMediaCapabilities } from './assistant-capabilities';
import { getActiveTierKeyByOrg } from './plan-features';
import { AI_IMAGE_TASKS, cleanDraftMediaSource, DRAFT_MEDIA_CAPS, type DraftMediaOptions } from './site-draft-media';

type Db = ReturnType<typeof getDb>;

/** The clip a draft asks for: the shortest length the video models take. */
export const DRAFT_VIDEO_SECONDS: VideoDurationSeconds = 6;

/** What this workspace may choose, and the live cost of each. Used by the Website tab, the chat card and the chat prompt. */
export async function draftMediaOptions(db: Db, orgId: number, onboardingContext: unknown): Promise<DraftMediaOptions> {
    const ctx = (onboardingContext && typeof onboardingContext === 'object' ? onboardingContext : {}) as Record<string, unknown>;
    let canImage = false; let canVideo = false; let tierVideo = false;
    try {
        const caps = await getOrgMediaCapabilities(db, orgId);
        canImage = caps.canImage; canVideo = caps.assistantCanVideo;
        tierVideo = tierCanGenerateVideo(await getActiveTierKeyByOrg(db, orgId));
    } catch (err) {
        console.error('[site-draft-media] could not read what AI media is allowed', err instanceof Error ? err.message : err);
    }
    return {
        images: {
            aiAllowed: canImage, aiWhyNot: canImage ? null : 'None of your assistants can generate AI images.',
            aiTasksEach: AI_IMAGE_TASKS, aiMax: DRAFT_MEDIA_CAPS.aiImages, stockMax: DRAFT_MEDIA_CAPS.stockImages,
        },
        videos: {
            aiAllowed: canVideo && tierVideo,
            aiWhyNot: !tierVideo ? 'AI video is on the Busywork Buster and Digital Employee plans.' : canVideo ? null : 'None of your assistants can generate AI videos.',
            aiTasksEach: aiVideoTasks(billedSecondsFor(DRAFT_VIDEO_SECONDS)), aiMax: DRAFT_MEDIA_CAPS.aiVideos, stockMax: DRAFT_MEDIA_CAPS.stockVideos,
        },
        answers: { images: cleanDraftMediaSource(ctx.sitePictures), videos: cleanDraftMediaSource(ctx.siteVideos) },
    };
}
