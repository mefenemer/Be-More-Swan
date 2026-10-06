// netlify/functions/admin-music-library.ts
// Admin → Music Library: see every track the library offers, and take one out of it.
//
//   GET  ?source=all|curated|community &status=all|active|withdrawn &q=text
//        → { counts, items: [{ id, title, artist, durationS, tags, isActive, kind, licenceName,
//                              createdAt, previewUrl, workspaces, creator? }] }
//   POST { action: 'withdraw', id, reason }   — stop offering it (reason required)
//   POST { action: 'restore',  id }           — offer it again
//   POST { action: 'edit', id, title?, tags? } — correct how it is listed
//   POST { action: 'delete', ids: [..], reason } — remove tracks from the library for good
//
// ── Why "withdraw", and never delete ────────────────────────────────────────────────────────────
// db/music-library.sql: withdrawal is NOT retroactive. A post that already carries a track was made
// and published with it; deleting the row or the file would turn that post silent, or break its
// render, long after anyone approved it. is_active=false stops a track being OFFERED (the picker and
// `select` both filter on it) and leaves every existing use exactly as it was.
//
// ── …and how 'delete' keeps that promise (added 2026-10-06, admins asked to clear tracks in bulk) ──
// A post never points at a music_tracks row. 'select' gives each workspace its OWN content_assets
// row carrying a copy of the track's storage_key, and rendering presigns that key. So:
//   · the music_tracks ROW can always go — no post reads it, and nothing has a foreign key to it;
//   · the R2 OBJECT goes only when NO content_assets row anywhere carries its key. If one does,
//     the file stays (orphaned from the library, still playing in that post). Checked per key at
//     delete time, not trusted from the list.
//
// Community tracks are the reason this screen exists: they enter the library the moment a customer
// shares one, with no human in between. The creator's workspace and original description are shown
// HERE only — to admins deciding whether a track belongs — and never in the library itself.
//
// Gated on `platform_config` (rank 3, platform_admin and above): an existing permission, so no role
// data has to change on either database before the screen works. Every change is audit-logged.

import jwt from 'jsonwebtoken';
import { and, eq, inArray, sql, desc } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, musicTracks, contentAssets, mediaGenerationJobs, organisations } from '../../db/schema';
import { hasPermission } from '../../src/utils/rbac';
import { insertAdminAuditLog, getAdminIp } from '../../src/utils/admin-audit';
import { presignR2Get } from '../../src/utils/social-publish';
import { COMMUNITY_MUSIC_PREFIX } from '../../src/lib/music-library';
import { withLambda } from '@netlify/aws-lambda-compat';

const PREVIEW_TTL_SEC = 3600;
/** The provider music-library.ts `select` stamps on a workspace's row for a library track. */
const LIBRARY_PROVIDER = 'library';
const TITLE_MAX = 120;
const TAGS_MAX = 12;

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

async function requireAdmin(event: any): Promise<{ id: number } | null> {
    const secret = process.env.JWT_SECRET;
    if (!secret) return null;
    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return null;
    let userId: number;
    try { userId = (jwt.verify(match[1], secret) as { userId: number }).userId; } catch { return null; }
    const [row] = await getDb().select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
    return hasPermission(row?.role, 'platform_config') ? { id: userId } : null;
}

/** Curated packs vs tracks customers shared. Decided by WHERE the file lives — the one fact a later
 *  edit to `source` cannot change. */
export function trackKind(storageKey: string): 'community' | 'curated' {
    return storageKey.startsWith(`${COMMUNITY_MUSIC_PREFIX}/`) ? 'community' : 'curated';
}

/** "media_generation_jobs:482" → 482. Anything else → null. */
export function jobIdFrom(sourceReference: string | null | undefined): number | null {
    const m = /^media_generation_jobs:(\d+)$/.exec(String(sourceReference || ''));
    return m ? Number(m[1]) : null;
}

/** Lower-case, trimmed, de-duplicated, capped — the vocabulary the picker filters on. */
export function cleanTags(raw: unknown): string[] {
    const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
    const out: string[] = [];
    for (const t of list) {
        const v = String(t).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 30);
        if (v && !out.includes(v)) out.push(v);
    }
    return out.slice(0, TAGS_MAX);
}

export default withLambda(async (event) => {
    const admin = await requireAdmin(event);
    if (!admin) return json(403, { error: 'Not allowed.' });
    const db = getDb();

    // ── List ────────────────────────────────────────────────────────────────────────────────────
    if (event.httpMethod === 'GET') {
        const q = event.queryStringParameters || {};
        const rows = await db.select().from(musicTracks).orderBy(desc(musicTracks.createdAt));

        const all = rows.map((r) => ({ ...r, kind: trackKind(r.storageKey) }));
        const counts = {
            total: all.length,
            active: all.filter((r) => r.isActive).length,
            withdrawn: all.filter((r) => !r.isActive).length,
            community: all.filter((r) => r.kind === 'community').length,
            curated: all.filter((r) => r.kind === 'curated').length,
        };

        const needle = String(q.q || '').trim().toLowerCase();
        const shown = all.filter((r) => {
            if (q.source === 'curated' && r.kind !== 'curated') return false;
            if (q.source === 'community' && r.kind !== 'community') return false;
            if (q.status === 'active' && !r.isActive) return false;
            if (q.status === 'withdrawn' && r.isActive) return false;
            if (!needle) return true;
            return r.title.toLowerCase().includes(needle) || r.artist.toLowerCase().includes(needle)
                || (r.tags || []).some((t) => t.includes(needle)) || String(r.id) === needle;
        });

        // How many workspaces have picked each track — the weight of a withdrawal decision.
        const ids = shown.map((r) => String(r.id));
        const usage = new Map<string, number>();
        if (ids.length) {
            const used = await db
                .select({ trackId: contentAssets.providerAssetId, workspaces: sql<number>`count(distinct ${contentAssets.organisationId})::int` })
                .from(contentAssets)
                .where(and(eq(contentAssets.provider, LIBRARY_PROVIDER), inArray(contentAssets.providerAssetId, ids)))
                .groupBy(contentAssets.providerAssetId);
            for (const u of used) if (u.trackId) usage.set(u.trackId, Number(u.workspaces) || 0);
        }

        // Who made a community track, and what they asked for — admins only, for moderation.
        const jobIds = shown.map((r) => jobIdFrom(r.sourceReference)).filter((n): n is number => n != null);
        const creators = new Map<number, { workspace: string | null; organisationId: number; prompt: string; sharedAt: string | null }>();
        if (jobIds.length) {
            const jobs = await db
                .select({ id: mediaGenerationJobs.id, organisationId: mediaGenerationJobs.organisationId, prompt: mediaGenerationJobs.prompt,
                    candidates: mediaGenerationJobs.candidates, workspace: organisations.name })
                .from(mediaGenerationJobs)
                .leftJoin(organisations, eq(organisations.id, mediaGenerationJobs.organisationId))
                .where(inArray(mediaGenerationJobs.id, jobIds));
            for (const j of jobs) {
                const meta = Array.isArray(j.candidates) ? (j.candidates as Array<{ consent?: { at?: string } }>)[0] : null;
                creators.set(j.id, { workspace: j.workspace ?? null, organisationId: j.organisationId, prompt: j.prompt, sharedAt: meta?.consent?.at ?? null });
            }
        }

        const items = await Promise.all(shown.slice(0, 500).map(async (r) => {
            const jobId = jobIdFrom(r.sourceReference);
            return {
                id: r.id, title: r.title, artist: r.artist, durationS: r.durationS, tags: r.tags || [],
                isActive: r.isActive, kind: r.kind, licenceName: r.licenceName, source: r.source,
                createdAt: r.createdAt, updatedAt: r.updatedAt,
                workspaces: usage.get(String(r.id)) ?? 0,
                previewUrl: await presignR2Get(r.storageKey, PREVIEW_TTL_SEC).catch(() => null),
                creator: jobId != null ? { jobId, ...(creators.get(jobId) || {}) } : null,
            };
        }));
        return json(200, { counts, items, truncated: shown.length > 500 });
    }

    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    let body: { action?: string; id?: number; ids?: unknown; reason?: string; title?: string; tags?: unknown };
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }

    if (body.action === 'delete') return deleteTracks(db, admin.id, event, body);
    const id = Number(body.id);
    if (!Number.isInteger(id) || id <= 0) return json(400, { error: 'id required.' });
    const [current] = await db.select().from(musicTracks).where(eq(musicTracks.id, id)).limit(1);
    if (!current) return json(404, { error: 'No such track.' });

    const audit = (newState: Record<string, unknown>, reason?: string) => void insertAdminAuditLog({
        adminId: admin.id,
        action: 'music_library_curation',
        targetType: 'music_track',
        targetId: String(id),
        previousState: { title: current.title, tags: current.tags, isActive: current.isActive },
        newState,
        reason,
        ipAddress: getAdminIp(event.headers as Record<string, string | undefined>),
        userAgent: (event.headers as Record<string, string | undefined>)['user-agent'],
    });

    if (body.action === 'withdraw' || body.action === 'restore') {
        const isActive = body.action === 'restore';
        const reason = String(body.reason || '').trim().slice(0, 500);
        // A withdrawal is a decision about something a customer contributed — it needs a why.
        if (!isActive && !reason) return json(400, { error: 'Say why the track is being withdrawn.' });
        await db.update(musicTracks).set({ isActive, updatedAt: new Date() }).where(eq(musicTracks.id, id));
        audit({ isActive }, reason || undefined);
        return json(200, { ok: true, isActive });
    }

    if (body.action === 'edit') {
        const patch: { title?: string; tags?: string[]; updatedAt: Date } = { updatedAt: new Date() };
        if (body.title !== undefined) {
            const title = String(body.title).replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
            if (!title) return json(400, { error: 'A track needs a title.' });
            patch.title = title;
        }
        if (body.tags !== undefined) patch.tags = cleanTags(body.tags);
        await db.update(musicTracks).set(patch).where(eq(musicTracks.id, id));
        audit({ title: patch.title ?? current.title, tags: patch.tags ?? current.tags });
        return json(200, { ok: true, title: patch.title ?? current.title, tags: patch.tags ?? current.tags });
    }

    return json(400, { error: 'Unknown action.' });
});

const DELETE_MAX = 200;

/** Remove the R2 object. Best-effort: a failure leaves an orphaned file, never a broken post. */
async function deleteR2Object(key: string): Promise<boolean> {
    const endpoint = process.env.R2_ENDPOINT;
    const accessKey = process.env.R2_ACCESS_KEY_ID;
    const secretKey = process.env.R2_SECRET_ACCESS_KEY;
    const bucket = process.env.R2_BUCKET_NAME;
    if (!endpoint || !accessKey || !secretKey || !bucket) return false;
    try {
        const { S3Client, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
        const s3 = new S3Client({ region: 'auto', endpoint, credentials: { accessKeyId: accessKey, secretAccessKey: secretKey } });
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        return true;
    } catch (err) {
        console.error(`[admin-music-library] could not delete R2 object ${key}:`, err);
        return false;
    }
}

async function deleteTracks(
    db: ReturnType<typeof getDb>,
    adminId: number,
    event: any,
    body: { ids?: unknown; reason?: string },
) {
    const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map(Number))]
        .filter((n) => Number.isInteger(n) && n > 0);
    if (!ids.length) return json(400, { error: 'Choose at least one track.' });
    if (ids.length > DELETE_MAX) return json(400, { error: `Delete at most ${DELETE_MAX} tracks at a time.` });
    const reason = String(body.reason || '').trim().slice(0, 500);
    if (!reason) return json(400, { error: 'Say why the tracks are being deleted.' });

    const rows = await db.select().from(musicTracks).where(inArray(musicTracks.id, ids));
    if (!rows.length) return json(404, { error: 'None of those tracks exist.' });

    // Which files a workspace still uses — by storage key, the thing a post actually renders from.
    const keys = rows.map((r) => r.storageKey);
    const inUse = new Set(
        (await db.selectDistinct({ key: contentAssets.storageKey })
            .from(contentAssets)
            .where(inArray(contentAssets.storageKey, keys)))
            .map((r) => r.key)
            .filter((k): k is string => !!k),
    );

    await db.delete(musicTracks).where(inArray(musicTracks.id, rows.map((r) => r.id)));

    let filesRemoved = 0;
    let filesKept = 0;
    for (const r of rows) {
        // Delete the row first, the file second: a crash in between leaves an unlisted file, which
        // is harmless; the other order would leave a listed track that plays silence.
        const keep = inUse.has(r.storageKey);
        const removed = keep ? false : await deleteR2Object(r.storageKey);
        if (removed) filesRemoved++; else filesKept++;
        void insertAdminAuditLog({
            adminId,
            action: 'music_library_delete',
            targetType: 'music_track',
            targetId: String(r.id),
            previousState: { title: r.title, artist: r.artist, storageKey: r.storageKey, isActive: r.isActive, source: r.source },
            newState: { deleted: true, fileRemoved: removed, fileKeptBecauseInUse: keep },
            reason,
            ipAddress: getAdminIp(event.headers as Record<string, string | undefined>),
            userAgent: (event.headers as Record<string, string | undefined>)['user-agent'],
        });
    }
    return json(200, { ok: true, deleted: rows.length, filesRemoved, filesKept });
}
