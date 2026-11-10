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

import { and, eq } from 'drizzle-orm';
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
