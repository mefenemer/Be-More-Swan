// src/utils/audio-levelling.ts
//
// The stored-file side of even loudness (src/lib/loudness-measure.ts does the maths):
//   · measureAsset      — the real loudness and peak of an audio asset, measured once from its file and
//                         kept on the asset (renderParams.loudness), so a rebuild doesn't fetch it again.
//   · levelledVoiceover — a copy of a voiceover raised (or lowered) to the target through a limiter,
//                         saved as a WAV beside the original and kept on it (renderParams.levelled), so
//                         the render plays it at volume 1. Captions still work: the copy carries the
//                         original's words.
//
// Measured "as it plays in a stereo video": a mono file counts in both channels, which is what the
// render does with it. MP3 (mpg123-decoder, WebAssembly — no ffmpeg on Netlify) and WAV are read;
// anything else returns null and the caller falls back to the sample table (src/lib/loudness.ts).

import { and, eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { contentAssets } from '../../db/schema';
import { integratedLufs, levelTo, readWav, samplePeakDb, wavBytes, type Pcm } from '../lib/loudness-measure';
import { persistBufferToR2 } from '../lib/media-persist';
import { presignR2Get } from './social-publish';

type Db = ReturnType<typeof getDb>;

/** Bump when the measuring or levelling changes, so kept results are made again. */
export const LEVELLING_VERSION = 2;
/**
 * The voice's ceiling: −2 dBFS, a decibel under the mix's −1, so the ducked music under it (peaks
 * about −18 dBFS) can't push the sum past full scale. At −1 a staging render peaked at +0.1 dBFS.
 */
export const VOICE_CEILING_DB = -2;
/** The longest file worth decoding here (a voiceover or bed is far shorter). */
const MAX_BYTES = 40 * 1024 * 1024;

export interface Loudness { lufs: number; peakDb: number; v: number }

/** Decode audio bytes to PCM — MP3 or WAV; null for anything else or a file that won't decode. */
export async function decodeAudio(bytes: Uint8Array, hint: string | null | undefined): Promise<Pcm | null> {
    const h = (hint ?? '').toLowerCase();
    let pcm: Pcm | null = null;
    if (/wav/.test(h) || String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF') pcm = readWav(bytes);
    else if (/mp3|mpeg/.test(h) || (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) {
        const { MPEGDecoder } = await import('mpg123-decoder');
        const d = new MPEGDecoder();
        await d.ready;
        try {
            const r = d.decode(bytes);
            if (r.channelData?.length && r.channelData[0].length) pcm = { channels: r.channelData, sampleRate: r.sampleRate };
        } finally { d.free(); }
    }
    if (!pcm) return null;
    // As it plays in a stereo video: a mono file is heard in both channels.
    return pcm.channels.length === 1 ? { channels: [pcm.channels[0], pcm.channels[0]], sampleRate: pcm.sampleRate } : pcm;
}

async function fetchStored(storageKey: string): Promise<Uint8Array | null> {
    const res = await fetch(await presignR2Get(storageKey, 600));
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.byteLength > 0 && buf.byteLength <= MAX_BYTES ? buf : null;
}

async function loadAsset(db: Db, orgId: number, assetId: number) {
    const [a] = await db.select().from(contentAssets)
        .where(and(eq(contentAssets.id, assetId), eq(contentAssets.organisationId, orgId), eq(contentAssets.assetType, 'audio'))).limit(1);
    return a ?? null;
}

const paramsOf = (a: { renderParams: unknown }) => (a.renderParams && typeof a.renderParams === 'object' ? a.renderParams as Record<string, unknown> : {});

/** The asset's real loudness, measured from its file once and kept. Null when it can't be read. */
export async function measureAsset(db: Db, orgId: number, assetId: number): Promise<Loudness | null> {
    const a = await loadAsset(db, orgId, assetId);
    if (!a?.storageKey) return null;
    const kept = paramsOf(a).loudness as Loudness | undefined;
    if (kept && kept.v === LEVELLING_VERSION && Number.isFinite(kept.lufs)) return kept;
    const bytes = await fetchStored(a.storageKey);
    const pcm = bytes ? await decodeAudio(bytes, a.mimeType ?? a.storageKey) : null;
    const lufs = pcm ? integratedLufs(pcm) : null;
    if (!pcm || lufs == null) return null;
    const loudness: Loudness = { lufs, peakDb: samplePeakDb(pcm), v: LEVELLING_VERSION };
    await db.update(contentAssets).set({ renderParams: { ...paramsOf(a), loudness } }).where(eq(contentAssets.id, a.id)).catch(() => {});
    return loudness;
}

/**
 * The voiceover levelled to `targetLufs` — a WAV copy, made once and kept on the original. Returns the
 * copy's asset id and its measured loudness; null when the original can't be read (the caller then
 * plays the original with a plain gain).
 */
export async function levelledVoiceover(db: Db, args: { orgId: number; userId: number; assetId: number; targetLufs: number }): Promise<{ assetId: number; lufs: number } | null> {
    const a = await loadAsset(db, args.orgId, args.assetId);
    if (!a?.storageKey) return null;
    const params = paramsOf(a);
    const kept = params.levelled as { assetId?: number; target?: number; lufs?: number; v?: number } | undefined;
    if (kept && kept.v === LEVELLING_VERSION && kept.target === args.targetLufs && kept.assetId && Number.isFinite(kept.lufs)) {
        const [still] = await db.select({ id: contentAssets.id }).from(contentAssets)
            .where(and(eq(contentAssets.id, kept.assetId), eq(contentAssets.organisationId, args.orgId))).limit(1);
        if (still) return { assetId: kept.assetId, lufs: kept.lufs! };
    }
    const bytes = await fetchStored(a.storageKey);
    const pcm = bytes ? await decodeAudio(bytes, a.mimeType ?? a.storageKey) : null;
    const done = pcm ? levelTo(pcm, args.targetLufs, { ceilingDb: VOICE_CEILING_DB }) : null;
    if (!done || done.lufs == null) return null;
    // A mono voice goes back as mono: half the bytes, and it plays the same.
    const out = pcm!.channels[0] === pcm!.channels[1] ? { channels: [done.pcm.channels[0]], sampleRate: done.pcm.sampleRate } : done.pcm;
    const file = wavBytes(out);
    const stored = await persistBufferToR2({ orgId: args.orgId, bytes: Buffer.from(file), contentType: 'audio/wav', folder: 'video-producer' });
    const [copy] = await db.insert(contentAssets).values({
        userId: a.userId ?? args.userId, organisationId: args.orgId,
        name: `${a.name} (levelled)`.slice(0, 200), assetType: 'audio', mimeType: 'audio/wav',
        fileSize: stored.fileSize, storageKey: stored.storageKey, durationS: a.durationS, provider: a.provider, prompt: a.prompt,
        // The original's words travel with it, so captions follow the levelled copy exactly.
        renderParams: { ...params, levelled: undefined, loudness: { lufs: done.lufs, peakDb: samplePeakDb(done.pcm), v: LEVELLING_VERSION }, levelledFrom: a.id, gainDb: done.gainDb },
        generationJobId: a.generationJobId, status: 'pending',
    }).returning({ id: contentAssets.id });
    await db.update(contentAssets).set({ renderParams: { ...params, levelled: { assetId: copy.id, target: args.targetLufs, lufs: done.lufs, v: LEVELLING_VERSION } } })
        .where(eq(contentAssets.id, a.id)).catch(() => {});
    return { assetId: copy.id, lufs: done.lufs };
}
