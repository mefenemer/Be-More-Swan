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
import { contentAssets, musicTracks } from '../../db/schema';
import { offerableTo, toTrack, usableTracks } from '../lib/music-library';
import type { LibraryTrack } from '../lib/video-music';

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
