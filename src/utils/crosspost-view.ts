// src/utils/crosspost-view.ts
//
// "Show a cross-post as one post" — the user's choice between seeing a post that went to
// Instagram, LinkedIn and X as ONE item, or as one item per platform.
//
// A cross-post is one scheduled_posts row per platform, all sharing a crosspost_group_id
// (stamped at fan-out). The Review Queue and the Calendar already render a group as one card.
// The two places that still listed every platform separately were the assistant's Activity feed
// and the notification inbox: publishing a 4-platform post wrote four "Post published to …"
// notifications (one per publisher run), so a week of posting filled the inbox with near-copies.
//
// Stored per user in user_profiles.preferences.combineCrossPosts. Default ON — an unset value
// means combined, the same default-on convention as the sound preferences beside it.

import { eq, inArray, sql } from 'drizzle-orm';
import { userProfiles, scheduledPosts, notifications } from '../../db/schema';
import { PLATFORM_FORMATS } from '../config/platform-formats';

export const COMBINE_CROSSPOSTS_PREF = 'combineCrossPosts';

/** Default-on: only an explicit false turns combining off. */
export function combineCrossPostsFrom(prefs: unknown): boolean {
    return !(prefs && typeof prefs === 'object' && (prefs as Record<string, unknown>)[COMBINE_CROSSPOSTS_PREF] === false);
}

export async function readCombineCrossPosts(db: any, userId: number): Promise<boolean> {
    try {
        const [row] = await db.select({ preferences: userProfiles.preferences })
            .from(userProfiles).where(eq(userProfiles.userId, userId)).limit(1);
        return combineCrossPostsFrom(row?.preferences);
    } catch {
        return true;
    }
}

// Notification types written once PER PLATFORM for one logical post. Drafts are already one
// notification per cross-post (process-content-jobs names every platform in the one row).
// post_publish_failed is deliberately NOT here: each failure has its own cause and its own fix
// (a dead Instagram token says nothing about LinkedIn), so merging them would hide the one
// that needs the user.
export const COMBINABLE_TYPES = ['post_published'] as const;

const isCombinable = (type: string) => (COMBINABLE_TYPES as readonly string[]).includes(type);

function postIdOf(n: { metadata?: unknown }): number | null {
    const raw = (n.metadata as any)?.postId;
    const num = typeof raw === 'string' ? Number(raw) : raw;
    return typeof num === 'number' && Number.isInteger(num) && num > 0 ? num : null;
}

export function platformLabel(platform: string | null | undefined): string {
    if (!platform) return '';
    return (PLATFORM_FORMATS as Record<string, { label: string }>)[platform]?.label ?? platform;
}

/** "Instagram", "Instagram and LinkedIn", "Facebook, Instagram and LinkedIn". */
export function joinPlatformLabels(labels: string[]): string {
    if (labels.length <= 1) return labels[0] ?? '';
    return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

interface NoteLike {
    id: number;
    type: string;
    isRead: boolean | null;
    readAt?: Date | string | null;
    metadata?: unknown;
}

/**
 * Collapse per-platform notifications of one cross-post into a single row. Pure — the caller
 * supplies postId → crosspost_group_id. Input order is preserved (newest-first from the GET), and
 * the merged row takes the NEWEST sibling's place and id, so it sorts where the latest platform
 * landed. `groupIds` lists every underlying id so a read/dismiss can act on all of them; it is
 * absent on rows that were not merged.
 *
 * A merged row is unread while ANY sibling is unread — otherwise the one unread platform would
 * vanish from the badge the moment it was folded into a row that reads as seen.
 */
export function combineCrossPostNotes<T extends NoteLike>(notes: T[], groupOfPost: Map<number, string>): T[] {
    const buckets = new Map<string, T[]>();
    const keyOf = (n: T): string | null => {
        if (!isCombinable(n.type)) return null;
        const pid = postIdOf(n);
        const g = pid !== null ? groupOfPost.get(pid) : undefined;
        return g ? `${n.type}|${g}` : null;
    };
    for (const n of notes) {
        const k = keyOf(n);
        if (!k) continue;
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k)!.push(n);
    }

    const out: T[] = [];
    const emitted = new Set<string>();
    for (const n of notes) {
        const k = keyOf(n);
        const siblings = k ? buckets.get(k)! : null;
        if (!k || !siblings || siblings.length < 2) { out.push(n); continue; }
        if (emitted.has(k)) continue;
        emitted.add(k);

        const head = siblings[0];
        const platforms = [...new Set(siblings
            .map(s => (s.metadata as any)?.platform as string | undefined)
            .filter((p): p is string => !!p))];
        const labels = platforms.map(platformLabel);
        const where = labels.length ? joinPlatformLabels(labels) : `${siblings.length} platforms`;
        const allRead = siblings.every(s => s.isRead);
        out.push({
            ...head,
            title: `Post published to ${where}`,
            message: `Your post has been published to ${where}.`,
            isRead: allRead,
            readAt: allRead ? head.readAt ?? null : null,
            groupIds: siblings.map(s => s.id),
            metadata: { ...(head.metadata as object | null ?? {}), platforms },
        });
    }
    return out;
}

/** postId → crosspost_group_id for the combinable notes in `notes` (one query, best-effort). */
export async function loadPostGroups(db: any, notes: NoteLike[]): Promise<Map<number, string>> {
    const ids = [...new Set(notes.filter(n => isCombinable(n.type)).map(postIdOf).filter((x): x is number => x !== null))];
    const map = new Map<number, string>();
    if (!ids.length) return map;
    try {
        const rows = await db.select({ id: scheduledPosts.id, groupId: scheduledPosts.crosspostGroupId })
            .from(scheduledPosts).where(inArray(scheduledPosts.id, ids));
        for (const r of rows) if (r.groupId) map.set(r.id, r.groupId);
    } catch { /* degrade to uncombined */ }
    return map;
}

/**
 * Widen a set of notification ids to every sibling a combined row stands for, so marking the
 * merged "Post published to Instagram and LinkedIn" read (or dismissing it) reaches both rows.
 * The client only knows the merged row's id; it never has to learn about grouping. Scoped to the
 * user throughout. Only call when combining is ON — with it off each row is its own item.
 */
export async function expandCrossPostIds(db: any, userId: number, ids: number[]): Promise<number[]> {
    if (!ids.length) return ids;
    try {
        const typeList = sql.join(COMBINABLE_TYPES.map(t => sql`${t}`), sql`, `);
        const idList = sql.join(ids.map(i => sql`${i}`), sql`, `);
        const res: any = await db.execute(sql`
            SELECT DISTINCT n2.id
            FROM ${notifications} n1
            JOIN ${scheduledPosts} p1
              ON (n1.metadata->>'postId') ~ '^[0-9]+$' AND p1.id = (n1.metadata->>'postId')::int
            JOIN ${scheduledPosts} p2
              ON p2.crosspost_group_id = p1.crosspost_group_id
            JOIN ${notifications} n2
              ON n2.user_id = n1.user_id AND n2.type = n1.type
             AND (n2.metadata->>'postId') ~ '^[0-9]+$' AND (n2.metadata->>'postId')::int = p2.id
            WHERE n1.user_id = ${userId}
              AND n1.id IN (${idList})
              AND n1.type IN (${typeList})
              AND p1.crosspost_group_id IS NOT NULL`);
        const rows: Array<{ id: number }> = Array.isArray(res) ? res : (res?.rows ?? []);
        return [...new Set([...ids, ...rows.map(r => Number(r.id))])];
    } catch (err) {
        console.warn('[crosspost-view] expandCrossPostIds failed — acting on the given ids only:', (err as any)?.message);
        return ids;
    }
}
