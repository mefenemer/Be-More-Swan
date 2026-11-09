// netlify/functions/footage.ts
// The owner's own videos, read for the Video Producer (docs/video-producer-footage-and-ai-plan.md §4.2).
// No server function can open a video, so the BROWSER reads it (src/components/footage-reader.js):
//
//   GET  ?list=1                → { videos: [{ id, name, durationS, url, needsReading, analysed, summary }] }
//                                  the workspace's own uploads (never stock or AI), newest first, at most 60
//   GET  ?ids=1,2               → { status: [{ assetId, needsReading, analysed, durationS, summary }] }
//   POST { action:'audio_url', assetId }   → { uploadUrl, key } — a presigned PUT for the video's sound (WAV)
//   POST { action:'prepare', assetId, durationS, width, height, frames:[{t,data}], audioKey|null }
//                                  → stores what the browser read (src/utils/footage-review.ts prepareFootage)
//
// Nothing here spends: the review that uses tasks is a video project (video-projects.ts create).
// Gate: the same as the Video Producer's — a plan that includes video.

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getDb } from '../../db/client';
import { requireTenant } from '../../src/utils/tenant';
import { getActiveTierKeyByOrg } from '../../src/utils/plan-features';
import { tierCanGenerateVideo } from '../../src/utils/ai-credits';
import { footageAudioPrefix, footageStatus, ownVideos, prepareFootage } from '../../src/utils/footage-review';
import { presignR2Get } from '../../src/utils/social-publish';
import { MAX_FOOTAGE_BYTES } from '../../src/lib/footage';
import { withLambda } from '@netlify/aws-lambda-compat';

const json = (statusCode: number, body: unknown) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** Five minutes of 16 kHz mono 16-bit WAV is ~9.6 MB; whisper takes 25 MB. */
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

function r2(): S3Client {
    return new S3Client({
        region: 'auto',
        endpoint: process.env.R2_ENDPOINT,
        credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! },
        // See storage-request-upload.ts for why WHEN_REQUIRED is needed for R2 presigned PUTs.
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
    });
}

export default withLambda(async (event) => {
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId } = ctx;

    if (!tierCanGenerateVideo(await getActiveTierKeyByOrg(db, orgId))) {
        return json(403, { error: 'video_requires_upgrade', message: 'Videos are on the Busywork Buster and Digital Employee plans.' });
    }

    if (event.httpMethod === 'GET') {
        const q = event.queryStringParameters ?? {};
        if (q.list) {
            const all = (await ownVideos(db, orgId)).reverse().slice(0, 60);
            const status = new Map((await footageStatus(db, orgId, all.map((v) => v.id))).map((s) => [s.assetId, s]));
            const videos = await Promise.all(all.map(async (v) => ({
                id: v.id, name: v.name, durationS: status.get(v.id)?.durationS ?? v.durationS, fileSize: v.fileSize,
                tooBig: (v.fileSize ?? 0) > MAX_FOOTAGE_BYTES,
                url: v.storageKey ? await presignR2Get(v.storageKey, 3600, { stableWindowSec: 1800 }).catch(() => null) : null,
                needsReading: status.get(v.id)?.needsReading ?? true,
                analysed: status.get(v.id)?.analysed ?? false,
                summary: status.get(v.id)?.summary ?? null,
            })));
            return json(200, { videos });
        }
        const ids = String(q.ids ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 20);
        const own = new Set((await ownVideos(db, orgId, ids)).map((v) => v.id));
        return json(200, { status: await footageStatus(db, orgId, ids.filter((id) => own.has(id))) });
    }
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    let body: Record<string, unknown>;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }
    const assetId = Number(body.assetId);
    if (!Number.isInteger(assetId) || assetId <= 0) return json(400, { error: 'assetId is required.' });

    if (body.action === 'audio_url') {
        const [v] = await ownVideos(db, orgId, [assetId]);
        if (!v) return json(404, { error: 'That video isn’t one of your own uploads.' });
        const size = Number(body.size);
        if (!(size > 44 && size <= MAX_AUDIO_BYTES)) return json(413, { error: 'The sound in that video is too long to read. Trim it first.' });
        if (!process.env.R2_ENDPOINT || !process.env.R2_BUCKET_NAME) return json(503, { error: 'Storage is not configured.' });
        const key = `${footageAudioPrefix(orgId, assetId)}audio-${Date.now()}.wav`;
        const uploadUrl = await getSignedUrl(r2(), new PutObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME, Key: key, ContentType: 'audio/wav', ContentLength: size,
        }), { expiresIn: 900 });
        return json(200, { uploadUrl, key });
    }

    if (body.action === 'prepare') {
        const done = await prepareFootage(db, orgId, {
            assetId,
            durationS: Number(body.durationS),
            width: body.width as number | null,
            height: body.height as number | null,
            frames: Array.isArray(body.frames) ? body.frames as Array<{ t: number; data: string }> : [],
            audioKey: typeof body.audioKey === 'string' ? body.audioKey : null,
        });
        return done.ok ? json(200, { ok: true }) : json(done.status, { error: done.error });
    }

    return json(400, { error: 'Unknown action.' });
});
