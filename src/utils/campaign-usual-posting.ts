// src/utils/campaign-usual-posting.ts
// What a live campaign does to the workspace's USUAL posting — Autopilot's scheduled social posts
// and articles. Owner, 2026-10-14: usual posts running alongside a campaign dilute it.
//
// Per campaign, per kind of work (campaigns.usual_posting):
//   make_way — the default. Social: Autopilot drafts nothing on a day that has a campaign post.
//              Articles: Autopilot writes no usual article while the campaign's own articles are
//              still being written or reviewed.
//   pause    — no usual posts of that kind at all.
//   normal   — as if there were no campaign.
// The strictest live campaign wins (pause > make_way > normal).
//
// ⚠️ Read ONLY from campaigns that are live (active/throttled). That is the whole restart story:
// when a campaign finishes, is paused or is stopped, it stops being read, and usual posting
// resumes on the next fill with nothing to switch back on (connection-pause-needs-a-resume).

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { campaignOrders, campaigns } from '../../db/schema';

type Db = ReturnType<typeof getDb>;

export const USUAL_POSTING_MODES = ['make_way', 'pause', 'normal'] as const;
export type UsualPostingMode = typeof USUAL_POSTING_MODES[number];
export type UsualPostingKind = 'social' | 'blog';
export interface UsualPosting { social: UsualPostingMode; blog: UsualPostingMode }

export const DEFAULT_USUAL_POSTING: UsualPosting = { social: 'make_way', blog: 'make_way' };

/** What each choice says, in the form and on the campaign card. */
export const USUAL_POSTING_LABELS: Record<UsualPostingKind, Record<UsualPostingMode, string>> = {
    social: {
        make_way: 'Make way — no usual posts on days the campaign posts',
        pause: 'Pause — no usual posts until the campaign ends',
        normal: 'Carry on as normal',
    },
    blog: {
        make_way: 'Make way — no usual articles while the campaign’s are being written',
        pause: 'Pause — no usual articles until the campaign ends',
        normal: 'Carry on as normal',
    },
};

function isMode(v: unknown): v is UsualPostingMode {
    return typeof v === 'string' && (USUAL_POSTING_MODES as readonly string[]).includes(v);
}

/** Anything stored or sent → a complete, valid setting. Unknown values fall back to the default. */
export function normaliseUsualPosting(raw: unknown): UsualPosting {
    const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    return {
        social: isMode(r.social) ? r.social : DEFAULT_USUAL_POSTING.social,
        blog: isMode(r.blog) ? r.blog : DEFAULT_USUAL_POSTING.blog,
    };
}

const STRICTNESS: Record<UsualPostingMode, number> = { normal: 0, make_way: 1, pause: 2 };

/**
 * The strictest setting across this workspace's LIVE campaigns, for one kind of work, and which
 * campaigns set it. `normal` with no campaigns when nothing is live.
 */
export async function usualPostingFor(db: Db, orgId: number, kind: UsualPostingKind): Promise<{ mode: UsualPostingMode; campaignIds: number[] }> {
    const live = await db.select({ id: campaigns.id, usualPosting: campaigns.usualPosting })
        .from(campaigns)
        .where(and(eq(campaigns.organisationId, orgId), inArray(campaigns.status, ['active', 'throttled'])));
    let mode: UsualPostingMode = 'normal';
    const ids: number[] = [];
    for (const c of live) {
        const m = normaliseUsualPosting(c.usualPosting)[kind];
        if (m === 'normal') continue;
        ids.push(c.id);
        if (STRICTNESS[m] > STRICTNESS[mode]) mode = m;
    }
    return { mode, campaignIds: ids };
}

/**
 * The days (UTC, YYYY-MM-DD) a campaign has a social post planned or being drafted for this
 * assistant — the days Autopilot makes way on.
 */
export async function campaignPostDays(db: Db, assistantId: number, campaignIds: number[]): Promise<Set<string>> {
    if (!campaignIds.length) return new Set();
    const rows = await db.execute(sql`
        SELECT to_char(coalesce(p.publish_date, j.target_publish_date) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day
          FROM content_generation_jobs j
          JOIN campaign_orders o ON o.id = j.campaign_order_id
          LEFT JOIN scheduled_posts p ON p.job_id = j.job_id
         WHERE j.assistant_id = ${assistantId}
           AND o.campaign_id IN (${sql.join(campaignIds.map((id) => sql`${id}`), sql`, `)})
           AND j.status IN ('queued', 'processing', 'completed')
           AND (p.id IS NULL OR p.status IN ('draft', 'pending_approval', 'in_review', 'approved', 'scheduled'))`);
    const list = (rows as unknown as { rows?: Array<{ day: string | null }> }).rows ?? (rows as unknown as Array<{ day: string | null }>);
    return new Set(list.map((r) => r.day).filter((d): d is string => !!d));
}

/** True while any of these campaigns still has articles being written, waiting, or in review. */
export async function campaignArticlesInFlight(db: Db, campaignIds: number[]): Promise<boolean> {
    if (!campaignIds.length) return false;
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(campaignOrders)
        .where(and(
            inArray(campaignOrders.campaignId, campaignIds),
            eq(campaignOrders.action, 'draft_blog_pillar'),
            inArray(campaignOrders.status, ['queued', 'issued', 'blocked', 'in_review']),
        ));
    return Number(row?.n ?? 0) > 0;
}
