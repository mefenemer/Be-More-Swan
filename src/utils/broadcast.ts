// src/utils/broadcast.ts — a notice to every customer, once each (admin → Comms → Broadcast).
//
// The first use is the 30 days' notice for AI video priced by the second (terms 5.2 / 20.2,
// docs/ai-video-per-second-notice.md). Before this there was no way to reach every customer:
// admin-send-notification.ts messages one user at a time.
//
// Rules that matter, each pinned by tests/broadcast.test.ts:
//   · Only notices listed in BROADCASTS can go out — an in-app template and an email template
//     with the same key, both written and reviewed in code. There is no free-text broadcast.
//   · Recipients: active users who belong to a workspace on a plan that is still running.
//   · Once each: a user who already has the notice's notification is skipped, so a second press,
//     a retried worker or a resend after a crash never sends twice.
//   · Real emails go out only from the production deploy. Anywhere else (staging, branch deploys,
//     local) the in-app notices are written but the email goes only to the admin who pressed the
//     button — staging's database holds real people's addresses.
import { sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';

type Db = ReturnType<typeof getDb>;

export interface BroadcastDef {
    /** Same key in NOTIFICATION_DEFAULTS (in-app) and TEMPLATE_DEFAULTS (email). */
    key: string;
    label: string;
    /** Why it exists — shown on the admin page so nobody sends it by accident. */
    purpose: string;
}

export const BROADCASTS: readonly BroadcastDef[] = [
    {
        key: 'ai_video_per_second_notice',
        label: 'AI video will count by length (from 3 December 2026)',
        purpose: '30 days\' notice required by terms 5.2 before AI video is priced by the second. Send by 2 November 2026 for a 3 December start.',
    },
];

export function broadcastDef(key: unknown): BroadcastDef | null {
    return BROADCASTS.find((b) => b.key === key) ?? null;
}

/** Plan statuses that still have a running subscription (and so are bound by the terms). */
export const LIVE_PLAN_STATUSES = ['active', 'past_due', 'cancelling', 'downgrading'] as const;

/** Real customer emails only from the production deploy (Netlify sets CONTEXT). */
export function emailsGoToCustomers(): boolean {
    return process.env.CONTEXT === 'production';
}

export interface Recipient { id: number; email: string; firstName: string | null }

/** Everyone who should get this notice and hasn't yet. */
export async function pendingRecipients(db: Db, key: string): Promise<Recipient[]> {
    const rows = await db.execute<{ id: number; email: string; first_name: string | null }>(sql`
        SELECT DISTINCT u.id, u.email, u.first_name
          FROM users u
          JOIN user_organisations uo ON uo.user_id = u.id
          JOIN plans p ON p.organisation_id = uo.organisation_id
         WHERE u.status = 'active'
           AND p.status IN (${sql.join(LIVE_PLAN_STATUSES.map((s) => sql`${s}`), sql`, `)})
           AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = u.id AND n.type = ${key})
         ORDER BY u.id`);
    return (rows as unknown as Array<{ id: number; email: string; first_name: string | null }>)
        .map((r) => ({ id: Number(r.id), email: r.email, firstName: r.first_name }));
}

/** How many already have it. */
export async function alreadySentCount(db: Db, key: string): Promise<number> {
    const rows = await db.execute<{ n: number }>(sql`SELECT COUNT(DISTINCT user_id)::int AS n FROM notifications WHERE type = ${key}`);
    return Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? 0);
}
