// src/utils/broadcast.ts — a notice to every customer, once each (Admin → Growth → Broadcast).
//
// The first use is the 30 days' notice for AI video priced by the second (terms 5.2 / 20.2,
// docs/ai-video-per-second-notice.md). Before this there was no way to reach every customer:
// admin-send-notification.ts messages one user at a time.
//
// Rules that matter, each pinned by tests/broadcast.test.ts:
//   · Only notices listed in BROADCASTS can go out — an in-app template and an email template
//     with the same key, both written and reviewed in code. There is no free-text broadcast.
//   · Recipients: active users who belong to a workspace on a plan that is still running — everyone in it, or
//     only its owners (user_organisations.role 'owner'). Each notice has a default audience; the admin picks
//     on the Broadcast page (owner, 2026-11-20: the ElevenLabs sub-processor notice goes to owners only).
//   · Once each: a user who already has the notice's notification is skipped, so a second press,
//     a retried worker or a resend after a crash never sends twice.
//   · Real emails go out only from the production deploy. Anywhere else (staging, branch deploys,
//     local) the in-app notices are written but the email goes only to the admin who pressed the
//     button — staging's database holds real people's addresses.
import { isProductionDeploy } from './deploy-context';
import { sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';

type Db = ReturnType<typeof getDb>;

/** Who a broadcast reaches: every member of a live workspace, only its owners, or — for one targeted notice — only the
 *  owners of workspaces that took bookings in the last 180 days and have no own address to send booking emails from. */
export const BROADCAST_AUDIENCES = ['owners', 'everyone', 'bookings_no_address'] as const;
export type BroadcastAudience = typeof BROADCAST_AUDIENCES[number];
export const AUDIENCE_LABELS: Record<BroadcastAudience, string> = {
    owners: 'Workspace owners', everyone: 'Everyone in each workspace',
    bookings_no_address: 'Owners of workspaces taking bookings with no email address set up',
};
/** The audiences a notice offers when it names none: the two general ones. A targeted audience is offered only by the
 *  notice written for it. */
export const GENERAL_AUDIENCES: readonly BroadcastAudience[] = ['owners', 'everyone'];
/** How far back a booking makes a workspace "taking bookings". */
export const BOOKINGS_LOOKBACK_DAYS = 180;

/** An audience from a request; anything else is null (refused, never guessed). Pure. */
export function readAudience(v: unknown): BroadcastAudience | null {
    return (BROADCAST_AUDIENCES as readonly unknown[]).includes(v) ? v as BroadcastAudience : null;
}

export interface BroadcastDef {
    /** Same key in NOTIFICATION_DEFAULTS (in-app) and TEMPLATE_DEFAULTS (email). */
    key: string;
    label: string;
    /** Why it exists — shown on the admin page so nobody sends it by accident. */
    purpose: string;
    /** Who the admin page offers first. They can still pick another this notice offers. */
    audience: BroadcastAudience;
    /** The audiences this notice may go to (default GENERAL_AUDIENCES). */
    audiences?: readonly BroadcastAudience[];
}

/** The audiences one notice may go to. */
export function audiencesFor(def: BroadcastDef): readonly BroadcastAudience[] {
    return def.audiences ?? GENERAL_AUDIENCES;
}

export const BROADCASTS: readonly BroadcastDef[] = [
    {
        key: 'ai_video_per_second_notice',
        label: 'AI video will count by length (from 3 December 2026)',
        purpose: '30 days\' notice required by terms 5.2 before AI video is priced by the second. Send by 2 November 2026 for a 3 December start.',
        audience: 'everyone',
    },
    {
        key: 'subprocessor_elevenlabs_notice',
        label: 'New sub-processor: ElevenLabs (voiceovers and transcription)',
        purpose: 'The 14 days\' notice in DPA clause 5 for adding ElevenLabs to the sub-processor list (Trust page, 19 November 2026). Owners may object to privacy@bemoreswan.com within 14 days of the email.',
        // The DPA's notice goes to the workspace owner (clause 5); the owner chose owners only (2026-11-20).
        audience: 'owners',
    },
    {
        key: 'subprocessor_recall_notice',
        label: 'New sub-processor: Recall.ai with AssemblyAI (Note Taker meetings, from 27 November 2026)',
        purpose: 'Courtesy notice for the Note Taker meeting bot (docs/note-taker-launch-notices-draft.md §2). DPA 1.2 names Recall.ai and AssemblyAI as specifically authorised, so no 14-day wait applies (legal review 2026-11-25); the Trust and privacy pages promise owners this email anyway. Send to owners before 27 November 2026.',
        audience: 'owners',
    },
    {
        key: 'subprocessor_google_cloud_notice',
        label: 'New sub-processor: Google Cloud (Gmail new-mail notices for the Email Assistant)',
        purpose: 'The 14 days\' notice in DPA clause 5 for adding Google Cloud Pub/Sub to the sub-processor list (docs/google-cloud-sub-processor-notice.md). Gmail push stays off on production until 14 days after this is sent. Owners may object to privacy@bemoreswan.com within 14 days of the email.',
        // DPA clause 5 notice goes to the workspace owner, as for ElevenLabs (owner, 2026-11-20).
        audience: 'owners',
    },
    {
        key: 'booking_emails_need_address_notice',
        label: 'Booking emails now need your own email address (owners with bookings and no address)',
        purpose: 'One-off notice (owner, 2026-11-27): since release #918, booking confirmations, reminders and other customer booking emails go only from the business\'s own address. This reaches only owners of workspaces that took bookings in the last 180 days and have no verified sending domain or connected Gmail/Outlook. Send once the release is live on production.',
        audience: 'bookings_no_address',
        audiences: ['bookings_no_address'],
    },
];

export function broadcastDef(key: unknown): BroadcastDef | null {
    return BROADCASTS.find((b) => b.key === key) ?? null;
}

/** Plan statuses that still have a running subscription (and so are bound by the terms). */
export const LIVE_PLAN_STATUSES = ['active', 'past_due', 'cancelling', 'downgrading'] as const;

/**
 * Real customer emails only from the production deploy.
 *
 * ⚠️ Not `process.env.CONTEXT` alone: that is a Netlify BUILD variable and is absent at function runtime
 * on this site, so production read as "not live" and the 2026-11-02 AI video notice reached 8 customers
 * in-app with 0 emails. The request's host is always there (src/utils/deploy-context.ts explains).
 *
 * Fails CLOSED the other way from isProductionDeploy(): no host means we can't tell, and a guess must
 * never email real customers from staging. Every caller here is an HTTP request, so a host is present.
 */
export function emailsGoToCustomers(headers: Record<string, string | undefined> | undefined | null): boolean {
    if (process.env.CONTEXT === 'production') return true;
    if (process.env.CONTEXT === 'branch-deploy' || process.env.CONTEXT === 'deploy-preview') return false;
    const host = String(headers?.host || headers?.['x-forwarded-host'] || '').trim();
    if (!host) return false;
    return isProductionDeploy(headers);
}

export interface Recipient { id: number; email: string; firstName: string | null }

/** Everyone who should get this notice and hasn't yet — or, for 'owners', only workspace owners; for
 *  'bookings_no_address', only owners of workspaces with a booking in the last BOOKINGS_LOOKBACK_DAYS days and no own
 *  address to send from (business-email.ts orgsWithRoute; a failed route check counts as no address). */
export async function pendingRecipients(db: Db, key: string, audience: BroadcastAudience, deps: { routed?: (db: Db, orgIds: number[]) => Promise<number[]> } = {}): Promise<Recipient[]> {
    const owners = audience === 'owners' || audience === 'bookings_no_address';
    const rows = await db.execute<{ id: number; email: string; first_name: string | null; org_id: number }>(sql`
        SELECT DISTINCT u.id, u.email, u.first_name, uo.organisation_id AS org_id
          FROM users u
          JOIN user_organisations uo ON uo.user_id = u.id
          JOIN plans p ON p.organisation_id = uo.organisation_id
         WHERE u.status = 'active'
           AND p.status IN (${sql.join(LIVE_PLAN_STATUSES.map((s) => sql`${s}`), sql`, `)})
           ${owners ? sql`AND uo.role = 'owner'` : sql``}
           ${audience === 'bookings_no_address' ? sql`AND EXISTS (SELECT 1 FROM bookings b WHERE b.organisation_id = uo.organisation_id AND b.created_at > now() - make_interval(days => ${BOOKINGS_LOOKBACK_DAYS}))` : sql``}
           AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = u.id AND n.type = ${key})
         ORDER BY u.id`);
    let list = rows as unknown as Array<{ id: number; email: string; first_name: string | null; org_id: number }>;
    if (audience === 'bookings_no_address' && list.length) {
        const routed = new Set(await (deps.routed ?? (async (d: Db, ids: number[]) => (await import('./business-email')).orgsWithRoute(d, ids)))(db, [...new Set(list.map((r) => Number(r.org_id)))]));
        list = list.filter((r) => !routed.has(Number(r.org_id)));
    }
    // One row per person (an owner of two workspaces appears once).
    const seen = new Set<number>();
    return list.filter((r) => !seen.has(Number(r.id)) && seen.add(Number(r.id)))
        .map((r) => ({ id: Number(r.id), email: r.email, firstName: r.first_name }));
}

/**
 * Has this person got the notice already? Read again just before each send: two sends of one notice can run at once
 * (owners, then everyone, before the first finishes), and the list each run read at its start would repeat people.
 */
export async function alreadyHas(db: Db, userId: number, key: string): Promise<boolean> {
    const rows = await db.execute<{ n: number }>(sql`SELECT 1 AS n FROM notifications WHERE user_id = ${userId} AND type = ${key} LIMIT 1`);
    return (rows as unknown as unknown[]).length > 0;
}

/** How many already have it. */
export async function alreadySentCount(db: Db, key: string): Promise<number> {
    const rows = await db.execute<{ n: number }>(sql`SELECT COUNT(DISTINCT user_id)::int AS n FROM notifications WHERE type = ${key}`);
    return Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? 0);
}
