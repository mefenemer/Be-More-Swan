// src/utils/video-music-asset.ts
//
// The Video Producer's way into the curated music library (src/lib/music-library.ts): which tracks it
// may use, and the workspace's own content_assets row for one. Same rules as the Sound picker
// (netlify/functions/music-library.ts `select`):
//   · only tracks that may be OFFERED now — active, licence not lapsed, and no attribution demanded
//     (nothing surfaces a credit in a caption yet, so those tracks are not ours to use: creditsEnabled false)
//   · a track is identified by its storage_key, never a URL; the workspace gets ONE row per track
//     (find-or-create on org + provider 'library' + providerAssetId) pointing at the one shared object,
//     which resolveAudioTracks presigns at render time, org-scoped.

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { getDb } from '../../db/client';
import { contentAssets, mediaGenerationJobs, musicTracks } from '../../db/schema';
import { offerableTo, toTrack, usableTracks } from '../lib/music-library';
import { madeMusicRequest, type LibraryTrack, type MusicMood } from '../lib/video-music';
import { buildMusicPrompt } from '../lib/music-prompt';
import { fetchMusicResult, MUSIC_MODEL, stabilityConfigured, StabilityError, StabilityPolicyError, submitMusic } from '../lib/stability-audio';
import { persistBufferToR2 } from '../lib/media-persist';
import { MUSIC_CREDIT_COST } from './ai-credits';
import { logMediaCost } from './ai-usage';

type Db = ReturnType<typeof getDb>;

/** Matches music-library.ts LIBRARY_PROVIDER. */
export const LIBRARY_PROVIDER = 'library';

/** Every track the Video Producer may lay under a video right now. */
export async function usableMusicTracks(db: Db, now = new Date()): Promise<LibraryTrack[]> {
    const rows = await db.select().from(musicTracks);
    const tracks = rows.map((row) => toTrack({
        id: row.id, title: row.title, artist: row.artist, storageKey: row.storageKey,
        durationS: row.durationS, tags: row.tags, isActive: row.isActive,
        licence: {
            name: row.licenceName, termsUrl: row.licenceTermsUrl ?? undefined,
            attributionRequired: row.attributionRequired,
            attributionText: row.attributionText ?? undefined,
            expiresAt: row.licenceExpiresAt ?? undefined,
        },
    })).filter((t): t is NonNullable<typeof t> => !!t);
    return offerableTo(usableTracks(tracks, now), { creditsEnabled: false })
        .map((t) => ({ id: t.id, title: t.title, storageKey: t.storageKey, durationS: t.durationS, tags: t.tags }));
}

/** This workspace's asset row for a library track (find-or-create). */
export async function musicAssetFor(db: Db, args: { orgId: number; userId: number; track: LibraryTrack; artist?: string | null }): Promise<number> {
    const [existing] = await db.select({ id: contentAssets.id }).from(contentAssets)
        .where(and(eq(contentAssets.organisationId, args.orgId), eq(contentAssets.provider, LIBRARY_PROVIDER), eq(contentAssets.providerAssetId, String(args.track.id))))
        .limit(1);
    if (existing) return existing.id;
    const [made] = await db.insert(contentAssets).values({
        userId: args.userId, organisationId: args.orgId,
        name: args.artist ? `${args.track.title} — ${args.artist}` : args.track.title,
        assetType: 'audio', durationS: args.track.durationS, storageKey: args.track.storageKey,
        provider: LIBRARY_PROVIDER, providerAssetId: String(args.track.id), attributionName: args.artist ?? null, status: 'pending',
    }).returning({ id: contentAssets.id });
    return made.id;
}

// ── The owner's own tracks (musicMood 'mine') ──────────────────────────────────────────────────────
//
// A track from My Content: one made with "✨ Generate music" (provider 'stability') or uploaded. Never a
// voiceover or a caption track (renderParams.kind 'voiceover'), never a purged file, and never a
// library row — the owner judged those not good enough (2026-11-10).

export interface OwnTrack { assetId: number; title: string; storageKey: string | null; durationS: number | null }

const isOwnMusic = (orgId: number) => and(
    eq(contentAssets.organisationId, orgId), eq(contentAssets.assetType, 'audio'), isNull(contentAssets.purgedAt),
    sql`coalesce(${contentAssets.provider}, '') <> ${LIBRARY_PROVIDER}`,
    sql`coalesce(${contentAssets.renderParams}->>'kind', '') <> 'voiceover'`,
);

/** The tracks this workspace could put under a video, newest first (the Music picker's list). */
export async function ownMusicTracks(db: Db, orgId: number, limit = 50): Promise<OwnTrack[]> {
    const rows = await db.select({ id: contentAssets.id, name: contentAssets.name, storageKey: contentAssets.storageKey, durationS: contentAssets.durationS })
        .from(contentAssets).where(isOwnMusic(orgId)).orderBy(desc(contentAssets.createdAt)).limit(limit);
    return rows.map((r) => ({ assetId: r.id, title: r.name || `Track ${r.id}`, storageKey: r.storageKey, durationS: r.durationS }));
}

/** One of those tracks, org-scoped; null when it isn't this workspace's music (or is gone). */
export async function ownMusicTrack(db: Db, orgId: number, assetId: number): Promise<OwnTrack | null> {
    const [r] = await db.select({ id: contentAssets.id, name: contentAssets.name, storageKey: contentAssets.storageKey, durationS: contentAssets.durationS })
        .from(contentAssets).where(and(eq(contentAssets.id, assetId), isOwnMusic(orgId))).limit(1);
    return r ? { assetId: r.id, title: r.name || `Track ${r.id}`, storageKey: r.storageKey, durationS: r.durationS } : null;
}

let _s3: S3Client | null = null;
/**
 * Is the file really there? A library row can outlive its file: on 2026-11-10 every library track's
 * object was missing from the shared bucket, and the render failed downloading the music — the whole
 * video lost for want of a bed. Checked before a track is used, so a missing file means no music,
 * not no video. True when storage isn't configured (nothing to ask; the render will say).
 */
export async function storedFileExists(storageKey: string): Promise<boolean> {
    if (!process.env.R2_ENDPOINT || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY || !process.env.R2_BUCKET_NAME) return true;
    _s3 ??= new S3Client({ region: 'auto', endpoint: process.env.R2_ENDPOINT, credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY } });
    try {
        await _s3.send(new HeadObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: storageKey }));
        return true;
    } catch (err) {
        const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
        return !(status === 404 || (err as { name?: string })?.name === 'NotFound');
    }
}

// ── A track MADE for a video (Stable Audio) ─────────────────────────────────────────────────────────
//
// The owner's choice, 2026-11-10: a mood means music made for the video, not a library track. Made at
// "Make the video", inside the build worker (a background function — it can wait for Stability), with
// a media_generation_jobs row for provenance (prompt, model, seed) like "✨ Generate music". Private:
// it is never shared to the community library. The caller holds and settles the charge.

const POLL_MS = 3000;
const GIVE_UP_MS = 4 * 60_000;

export async function makeVideoTrack(db: Db, args: { orgId: number; userId: number; assistantId?: number | null; mood: MusicMood; videoS: number; title: string }): Promise<{ assetId: number; title: string }> {
    if (!stabilityConfigured()) throw new Error('music generation is not available');
    const req = madeMusicRequest(args.mood, args.videoS);
    const built = buildMusicPrompt(req);
    if (!built.ok) throw new Error(built.error);
    const [job] = await db.insert(mediaGenerationJobs).values({
        organisationId: args.orgId, userId: args.userId, assistantId: args.assistantId ?? null, mediaType: 'audio', prompt: built.prompt,
        aspectRatio: 'none', durationSeconds: built.durationS, model: MUSIC_MODEL, creditCost: MUSIC_CREDIT_COST, status: 'processing',
        candidates: [{ name: args.title, share: false, videoProducer: true }],
    }).returning({ id: mediaGenerationJobs.id });
    const failJob = (message: string) => db.update(mediaGenerationJobs).set({ status: 'failed', errorMessage: message.slice(0, 500), updatedAt: new Date() })
        .where(eq(mediaGenerationJobs.id, job.id)).catch(() => {});
    try {
        const { id } = await submitMusic({ prompt: built.prompt, durationS: built.durationS });
        await db.update(mediaGenerationJobs).set({ falRequestId: id, updatedAt: new Date() }).where(eq(mediaGenerationJobs.id, job.id));
        const deadline = Date.now() + GIVE_UP_MS;
        let result: Awaited<ReturnType<typeof fetchMusicResult>> = { done: false };
        let blips = 0;
        while (!result.done) {
            if (Date.now() > deadline) throw new Error('music generation timed out');
            await new Promise((r) => setTimeout(r, POLL_MS));
            try { result = await fetchMusicResult(id); blips = 0; }
            catch (err) {
                const retry = !(err instanceof StabilityError) || err.status === 429 || err.status >= 500;
                if (err instanceof StabilityPolicyError || !retry || ++blips > 3) throw err;
            }
        }
        const stored = await persistBufferToR2({ orgId: args.orgId, bytes: result.bytes, contentType: result.contentType || 'audio/mpeg', folder: 'generated-music' });
        const [asset] = await db.insert(contentAssets).values({
            userId: args.userId, organisationId: args.orgId, name: args.title.slice(0, 80),
            assetType: 'audio', mimeType: result.contentType || 'audio/mpeg', fileSize: stored.fileSize, storageKey: stored.storageKey,
            durationS: built.durationS, provider: 'stability', providerAssetId: id,
            attributionName: 'Generated with Stable Audio (Stability AI)', prompt: built.prompt, generationJobId: job.id, status: 'pending',
        }).returning({ id: contentAssets.id });
        await db.update(mediaGenerationJobs).set({ status: 'completed', resultAssetIds: [asset.id], updatedAt: new Date() }).where(eq(mediaGenerationJobs.id, job.id));
        logMediaCost(MUSIC_MODEL, {}, { workspaceId: args.orgId, userId: args.userId, assistantId: args.assistantId ?? null, sessionId: 'stability-music' });
        return { assetId: asset.id, title: args.title.slice(0, 80) };
    } catch (err) {
        await failJob(err instanceof Error ? err.message : String(err));
        throw err;
    }
}
