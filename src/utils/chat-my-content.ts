// src/utils/chat-my-content.ts
// What is in My Content, as the chat of an assistant with a "My Content" tab sees it.
//
// ── Why ──────────────────────────────────────────────────────────────────────────────────────────
// Owner, 2026-11-10: "both the user and the assistant can find their media content". The Video
// Producer, Brand Designer and Blog Writer pages show My Content as a tab, but their chats knew only
// that a library existed — asked "where's the video you made last week?" or "which flyers have I
// got?", the assistant could not say. This lists the newest files by name, kind and maker, so the
// chat can point at one on the "My Content" tab (and the Video Producer at its own finished videos).
//
// Read-only: nothing here proposes or changes anything. Never throws.
//
// Scoped like the tab itself (netlify/functions/content-assets.ts lists the signed-in user's
// assets), so the chat never names a file the user cannot find on the tab.

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { contentAssets } from '../../db/schema';

type Db = ReturnType<typeof getDb>;

/** Roles whose page has the My Content tab (assistant-dashboard-registry.js myContentTab), and the
 *  asset types each one's chat is told about. Pinned by tests/chat-my-content.test.ts. */
export const MY_CONTENT_ROLES: Readonly<Record<string, readonly string[]>> = {
    video_producer: ['video'],
    brand_designer: ['image', 'document'],
    blog_writer: ['image', 'video'],
    social_media_manager: ['image', 'video'],
};

const LIST_MAX = 25;

/** Who made it, in the words My Content's source badges use (my-content.js _sourceKey). */
export function madeBy(provider: string | null): string {
    if (!provider) return 'their upload';
    if (provider === 'video_producer') return 'made by the Video Producer';
    if (provider === 'flyer') return 'a printed flyer';
    if (provider === 'brand_card') return 'a branded card';
    if (provider === 'fal' || provider === 'remotion' || provider === 'design') return 'made by an assistant';
    if (provider === 'canva') return 'from Canva';
    return 'stock, found by an assistant';
}

function shapeOf(w: number | null, h: number | null): string {
    if (!w || !h) return '';
    const r = w / h;
    if (Math.abs(r - 9 / 16) < 0.03) return 'vertical 9:16';
    if (Math.abs(r - 1) < 0.03) return 'square';
    if (Math.abs(r - 16 / 9) < 0.03) return 'wide 16:9';
    return r < 1 ? 'portrait' : 'landscape';
}

export interface MyContentRow {
    id: number; name: string; assetType: string; provider: string | null;
    width: number | null; height: number | null; durationS: number | null; createdAt: Date | string;
}

/** One line per file. Pure. */
export function describeAsset(r: MyContentRow): string {
    const kind = r.provider === 'flyer' ? 'flyer' : r.provider === 'brand_card' ? 'card' : r.assetType === 'document' ? 'document' : r.assetType;
    const bits = [kind, shapeOf(r.width, r.height), r.durationS ? `${Math.round(r.durationS)} s` : '', madeBy(r.provider)].filter(Boolean);
    const day = new Date(r.createdAt);
    const when = Number.isNaN(day.getTime()) ? '' : `, ${day.toISOString().slice(0, 10)}`;
    return `- #${r.id} "${r.name.replace(/\s+/g, ' ').trim()}" — ${bits.join(', ')}${when}`;
}

/** The block for this turn's prompt. Null for a role without the tab, or when the read fails. */
export async function buildMyContentBlock(db: Db, args: { userId: number; roleKey: string | null | undefined }): Promise<string | null> {
    const types = args.roleKey ? MY_CONTENT_ROLES[args.roleKey] : undefined;
    if (!types) return null;
    try {
        const scope = and(eq(contentAssets.userId, args.userId), inArray(contentAssets.assetType, [...types]), isNull(contentAssets.purgedAt));
        const [[c], rows] = await Promise.all([
            db.select({ n: sql<number>`count(*)::int` }).from(contentAssets).where(scope),
            db.select({
                id: contentAssets.id, name: contentAssets.name, assetType: contentAssets.assetType, provider: contentAssets.provider,
                width: contentAssets.width, height: contentAssets.height, durationS: contentAssets.durationS, createdAt: contentAssets.createdAt,
            }).from(contentAssets).where(scope).orderBy(desc(contentAssets.createdAt)).limit(LIST_MAX),
        ]);
        const total = Number(c?.n) || 0;
        const what = args.roleKey === 'video_producer' ? 'video' : args.roleKey === 'brand_designer' ? 'picture, card and flyer' : 'picture and video';
        const list = rows.map(describeAsset).join('\n') + (total > rows.length ? `\n- …and ${total - rows.length} older` : '');
        return `MY CONTENT ("My Content" tab on your page — the same library every assistant uses) — ${total} ${what} file${total === 1 ? '' : 's'}${total ? ', newest first:\n' + list : '.'}
When the user asks where something is, what they have, or for a file by name or date, answer from this list: name it and say it is on the "My Content" tab, where they can filter by type, open, download or delete it. Never claim a file exists that is not listed here, and never describe what one shows beyond its name. Deleting or renaming a file is done on that tab, not in this chat.`;
    } catch (err) {
        console.error('[chat-my-content] could not build the block (non-fatal)', err);
        return null;
    }
}
