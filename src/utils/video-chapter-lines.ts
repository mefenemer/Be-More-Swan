// src/utils/video-chapter-lines.ts
//
// YouTube chapter lines for a post's video, when that video is a finished Video Producer video
// (its output file is attached to the post). Read by publish-youtube-background.ts, which adds them
// to the end of the description unless the caption already has a "0:00" line. See src/lib/video-chapters.ts.

import { and, eq, inArray } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { videoProjects } from '../../db/schema';
import { chaptersFor } from '../lib/video-chapters';

type Db = ReturnType<typeof getDb>;

/** The "0:00 Title" lines for the first attached Video Producer video that has them, or null. Never throws. */
export async function postVideoChapterLines(db: Db, organisationId: number, contentAssetIds: unknown): Promise<string | null> {
    const ids = (Array.isArray(contentAssetIds) ? contentAssetIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 20);
    if (!ids.length) return null;
    try {
        const rows = await db.select({ outputAssetId: videoProjects.outputAssetId, timeline: videoProjects.timeline, brief: videoProjects.brief, storyboard: videoProjects.storyboard })
            .from(videoProjects)
            .where(and(eq(videoProjects.organisationId, organisationId), eq(videoProjects.status, 'ready'), inArray(videoProjects.outputAssetId, ids)));
        for (const id of ids) {
            const r = rows.find((x) => x.outputAssetId === id);
            if (!r) continue;
            const lines = chaptersFor(r).youtubeChapters;
            if (lines) return lines;
        }
    } catch (e) {
        console.warn('[video-chapter-lines] read failed:', e instanceof Error ? e.message : e);
    }
    return null;
}
