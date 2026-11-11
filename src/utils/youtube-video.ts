// src/utils/youtube-video.ts
//
// A Video Producer video on YouTube (src/lib/youtube-extras.ts says what and why):
//   · afterYouTubeUpload — once publish-youtube-background has the video id: the thumbnail, then the
//     caption tracks (English + every translation) when the connection granted youtube.force-ssl.
//     Never fails the post: each part is best-effort and its outcome is returned for the log.
//   · youtubeResultsFor — views, likes and comments for the video's YouTube posts, plus the drop-off
//     curve when yt-analytics.readonly was granted. Cached on the project's timeline for six hours.
//   · videoCaptionLines — the spoken words of a finished video as caption file lines.

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { contentAssets, scheduledPosts, videoProjects } from '../../db/schema';
import { timelineWords } from '../lib/captions';
import { resolveCaptionSources } from '../lib/post-render';
import type { Storyboard } from '../lib/storyboard';
import {
    biggestDrop, captionLines, CAPTION_LANGUAGES, hasScope, readCaptionLines, readRetention, readStats, toSrt, watchedToEndPct,
    YT_SCOPE_ANALYTICS, YT_SCOPE_CAPTIONS, type CaptionLine, type RetentionPoint, type YouTubeStats,
} from '../lib/youtube-extras';
import { presignR2Get, resolveSocialCredentials } from './social-publish';
import { getIntegration } from './workspace-integrations';

type Db = ReturnType<typeof getDb>;
type ProjectRow = typeof videoProjects.$inferSelect;
type Timeline = { audio?: unknown; durationS?: number; captionTranslations?: Record<string, { lines?: unknown; at?: string }>; youtube?: YouTubeCache } & Record<string, unknown>;

/** The spoken words of a finished video as caption file lines (English, as said). [] when it has no captioned voice. */
export async function videoCaptionLines(db: Db, orgId: number, timeline: unknown): Promise<CaptionLine[]> {
    const tl = timeline as Timeline | null;
    if (!tl?.audio) return [];
    const { sources } = await resolveCaptionSources(db, tl.audio, orgId);
    return captionLines(timelineWords(sources).map((w) => ({ word: w.text, startS: w.startS, endS: w.endS })));
}

/** Its translations, by language code, as stored on the timeline (translate_captions). */
export function translationsOf(timeline: unknown): Record<string, CaptionLine[]> {
    const raw = (timeline as Timeline | null)?.captionTranslations ?? {};
    const out: Record<string, CaptionLine[]> = {};
    for (const [code, v] of Object.entries(raw)) {
        const lines = readCaptionLines(v?.lines);
        if (CAPTION_LANGUAGES[code] && lines.length) out[code] = lines;
    }
    return out;
}

/** The finished Video Producer video among these assets, if any. */
export async function projectForAssets(db: Db, orgId: number, contentAssetIds: unknown): Promise<ProjectRow | null> {
    const ids = (Array.isArray(contentAssetIds) ? contentAssetIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 20);
    if (!ids.length) return null;
    const [row] = await db.select().from(videoProjects)
        .where(and(eq(videoProjects.organisationId, orgId), eq(videoProjects.status, 'ready'), inArray(videoProjects.outputAssetId, ids)))
        .orderBy(desc(videoProjects.updatedAt)).limit(1);
    return row ?? null;
}

const THUMB_MAX_BYTES = 2 * 1024 * 1024;
const STILL_SOURCES = new Set(['brand_card', 'product_photo', 'ai_image', 'stock_photo']);

/** The picture to use: the post's own image, else the video's first still scene. */
async function thumbnailAsset(db: Db, orgId: number, contentAssetIds: unknown, project: ProjectRow | null): Promise<{ storageKey: string; mimeType: string } | null> {
    const ids = (Array.isArray(contentAssetIds) ? contentAssetIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    const sceneIds: number[] = [];
    if (project) {
        const sb = project.storyboard as Storyboard | null;
        const assets = (project.sceneAssets ?? {}) as Record<string, number>;
        for (const s of sb?.scenes ?? []) if (STILL_SOURCES.has(s.source) && assets[s.id]) sceneIds.push(assets[s.id]);
    }
    const want = [...ids, ...sceneIds];
    if (!want.length) return null;
    const rows = await db.select({ id: contentAssets.id, assetType: contentAssets.assetType, mimeType: contentAssets.mimeType, storageKey: contentAssets.storageKey, fileSize: contentAssets.fileSize })
        .from(contentAssets).where(and(inArray(contentAssets.id, want), eq(contentAssets.organisationId, orgId)));
    for (const id of want) {
        const r = rows.find((x) => x.id === id);
        const mime = String(r?.mimeType ?? '').toLowerCase();
        if (r?.storageKey && (r.assetType ?? '').toLowerCase() === 'image' && /^image\/(jpe?g|png)$/.test(mime) && (r.fileSize == null || r.fileSize <= THUMB_MAX_BYTES)) {
            return { storageKey: r.storageKey, mimeType: mime === 'image/jpg' ? 'image/jpeg' : mime };
        }
    }
    return null;
}

/** Upload one SRT caption track to a YouTube video (captions.insert, multipart). */
async function insertCaptionTrack(token: string, videoId: string, language: string, name: string, srt: string): Promise<{ ok: boolean; error?: string }> {
    const boundary = `bms${Math.random().toString(36).slice(2)}`;
    const meta = JSON.stringify({ snippet: { videoId, language, name, isDraft: false } });
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/x-subrip; charset=UTF-8\r\n\r\n${srt}\r\n--${boundary}--`;
    const res = await fetch('https://www.googleapis.com/upload/youtube/v3/captions?part=snippet&uploadType=multipart', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
    });
    if (res.ok) return { ok: true };
    const err: { error?: { message?: string } } = await res.json().catch(() => ({}));
    return { ok: false, error: err.error?.message || `captions ${res.status}` };
}

export interface AfterUploadOutcome { thumbnail: 'set' | 'none' | string; captions: string[] }

/**
 * After a YouTube upload: set the thumbnail and add the caption tracks. Never throws; the outcome is
 * for the log and the post's note. A channel without phone verification can't have custom thumbnails —
 * YouTube says so, and the video keeps the frame YouTube chose.
 */
export async function afterYouTubeUpload(db: Db, args: { orgId: number; videoId: string; token: string; contentAssetIds: unknown }): Promise<AfterUploadOutcome> {
    const out: AfterUploadOutcome = { thumbnail: 'none', captions: [] };
    try {
        const project = await projectForAssets(db, args.orgId, args.contentAssetIds).catch(() => null);
        const thumb = await thumbnailAsset(db, args.orgId, args.contentAssetIds, project).catch(() => null);
        if (thumb) {
            const src = await fetch(await presignR2Get(thumb.storageKey, 600));
            const bytes = src.ok ? Buffer.from(await src.arrayBuffer()) : null;
            if (bytes && bytes.byteLength <= THUMB_MAX_BYTES) {
                const res = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(args.videoId)}`, {
                    method: 'POST', headers: { Authorization: `Bearer ${args.token}`, 'Content-Type': thumb.mimeType }, body: bytes,
                });
                const err: { error?: { message?: string } } = res.ok ? {} : await res.json().catch(() => ({}));
                out.thumbnail = res.ok ? 'set' : `refused: ${err.error?.message || res.status}`;
            }
        }
        if (project) {
            const integ = await getIntegration(db, args.orgId, 'youtube').catch(() => null);
            if (hasScope(integ?.scopes, YT_SCOPE_CAPTIONS)) {
                const english = await videoCaptionLines(db, args.orgId, project.timeline);
                const tracks: Array<[string, string, CaptionLine[]]> = english.length ? [['en-GB', 'English', english]] : [];
                for (const [code, lines] of Object.entries(translationsOf(project.timeline))) tracks.push([code, CAPTION_LANGUAGES[code], lines]);
                for (const [code, name, lines] of tracks) {
                    const r = await insertCaptionTrack(args.token, args.videoId, code, name, toSrt(lines)).catch((e) => ({ ok: false, error: String(e?.message || e) }));
                    out.captions.push(r.ok ? code : `${code} refused: ${r.error}`);
                }
            }
        }
    } catch (e) {
        console.warn('[youtube-video] after upload:', e instanceof Error ? e.message : e);
    }
    return out;
}

// ── Results ───────────────────────────────────────────────────────────────────────────────────────

export interface YouTubeCache {
    at: string;
    posts: Array<{ postId: number; videoId: string; url: string | null; publishedAt: string | null; stats: YouTubeStats | null }>;
    retention: RetentionPoint[] | null;
    averageViewS: number | null;
    /** Why there's no drop-off curve: the switch is off / the connection lacks the permission / too new. */
    retentionNote: string | null;
}

export interface YouTubeResults extends YouTubeCache {
    totals: YouTubeStats;
    drop: { atS: number; lostPct: number } | null;
    toEndPct: number | null;
}

const CACHE_MS = 6 * 3600_000;

/** The YouTube posts that carry this video (published, with a video id), newest first. */
async function youtubePostsFor(db: Db, orgId: number, outputAssetId: number) {
    return db.select({ id: scheduledPosts.id, platformPostId: scheduledPosts.platformPostId, platformPostUrl: scheduledPosts.platformPostUrl, publishedAt: scheduledPosts.publishedAt, connectionId: scheduledPosts.connectionId })
        .from(scheduledPosts)
        .where(and(eq(scheduledPosts.organisationId, orgId), eq(scheduledPosts.platform, 'youtube'), eq(scheduledPosts.status, 'published'),
            sql`${scheduledPosts.contentAssetIds} @> ${JSON.stringify([outputAssetId])}::jsonb`))
        .orderBy(desc(scheduledPosts.publishedAt)).limit(10);
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * How this video is doing on YouTube, or null when it hasn't been posted there. Reads YouTube at most
 * every six hours (or when `fresh`), keeping the last good figures if a read fails.
 */
export async function youtubeResultsFor(db: Db, orgId: number, row: ProjectRow, opts: { fresh?: boolean } = {}): Promise<YouTubeResults | null> {
    if (!row.outputAssetId) return null;
    const tl = (row.timeline ?? {}) as Timeline;
    let cache = tl.youtube ?? null;
    const stale = !cache || opts.fresh || Date.now() - new Date(cache.at).getTime() > CACHE_MS;
    if (stale) {
        const posts = await youtubePostsFor(db, orgId, row.outputAssetId).catch(() => []);
        const withIds = posts.filter((p) => p.platformPostId);
        if (!withIds.length) return null;
        try {
            const creds = await resolveSocialCredentials(db, { organisationId: orgId, platform: 'youtube', connectionId: withIds[0].connectionId ?? null });
            const ids = withIds.map((p) => p.platformPostId!).join(',');
            const vr = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${encodeURIComponent(ids)}`, { headers: { Authorization: `Bearer ${creds.token}` } });
            const vdata: { items?: Array<{ id?: string }> } = vr.ok ? await vr.json() : {};
            const statsById = new Map((vdata.items ?? []).map((it) => [String(it.id), readStats(it)]));
            const integ = await getIntegration(db, orgId, 'youtube').catch(() => null);
            let retention: RetentionPoint[] | null = null, averageViewS: number | null = null, retentionNote: string | null = null;
            if (!hasScope(integ?.scopes, YT_SCOPE_ANALYTICS)) {
                retentionNote = 'needs_permission';
            } else {
                const first = withIds[withIds.length - 1];
                const start = isoDay(first.publishedAt ?? new Date(Date.now() - 30 * 86400_000));
                const base = `https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&startDate=${start}&endDate=${isoDay(new Date())}&filters=video==${encodeURIComponent(first.platformPostId!)}`;
                const [cr, ar] = await Promise.all([
                    fetch(`${base}&metrics=audienceWatchRatio&dimensions=elapsedVideoTimeRatio`, { headers: { Authorization: `Bearer ${creds.token}` } }),
                    fetch(`${base}&metrics=views,averageViewDuration`, { headers: { Authorization: `Bearer ${creds.token}` } }),
                ]);
                retention = cr.ok ? readRetention(await cr.json()) : null;
                const avg: { rows?: unknown[][] } = ar.ok ? await ar.json() : {};
                averageViewS = Number.isFinite(Number(avg.rows?.[0]?.[1])) ? Number(avg.rows![0][1]) : null;
                if (!retention?.length) retentionNote = 'too_new';
            }
            cache = {
                at: new Date().toISOString(),
                posts: withIds.map((p) => ({ postId: p.id, videoId: p.platformPostId!, url: p.platformPostUrl, publishedAt: p.publishedAt ? p.publishedAt.toISOString() : null, stats: statsById.get(p.platformPostId!) ?? null })),
                retention: retention?.length ? retention : null, averageViewS, retentionNote,
            };
            await db.update(videoProjects).set({ timeline: { ...tl, youtube: cache } }).where(eq(videoProjects.id, row.id));
        } catch (e) {
            console.warn('[youtube-video] results:', e instanceof Error ? e.message : e);
            if (!cache) return null;
        }
    }
    if (!cache) return null;
    const totals = cache.posts.reduce<YouTubeStats>((t, p) => ({
        views: t.views + (p.stats?.views ?? 0),
        likes: p.stats?.likes == null ? t.likes : (t.likes ?? 0) + p.stats.likes,
        comments: p.stats?.comments == null ? t.comments : (t.comments ?? 0) + p.stats.comments,
    }), { views: 0, likes: null, comments: null });
    const durationS = Number(tl.durationS) || 0;
    return { ...cache, totals, drop: cache.retention ? biggestDrop(cache.retention, durationS) : null, toEndPct: cache.retention ? watchedToEndPct(cache.retention) : null };
}
