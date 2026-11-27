// src/utils/product-update-recipients.ts
// Who receives the weekly "What's new" email. ONE definition, used by the count the admin sees
// before approving AND by the worker that sends — so "this will go to 214 customers" is exactly
// who it goes to.
//
// A recipient is a customer account (role 'user' — staff accounts are not customers) that is
// active, is not in its 24-hour deletion cooling-off, and has not turned "What's new" emails off
// (user_profiles.email_preferences.whats_new = false, written by the unsubscribe link or the
// account Notification Preferences matrix). No profile row = never chose = default ON.
// Test, app-review and the owner's own accounts are role 'user' too, so they are excluded by
// address (owner, 2026-11-13).
//
// Send to (owner, 2026-11-27): the admin ticks plan groups on each email. Owners AND teammates
// count — a person belongs to a group when ANY workspace they are in has that kind of current
// plan. 'no_plan' is everyone with no current plan anywhere, so ticking all four is exactly the
// old list: paying, trial and beta users are never left out unless the admin unticks them.

import { and, asc, eq, gt, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { users, userProfiles } from '../../db/schema';
import type { getDb } from '../../db/client';

type Db = ReturnType<typeof getDb>;

/** Never sent the "What's new" email. Lower case; compared against lower(users.email). */
export const EXCLUDED_RECIPIENT_EMAILS: readonly string[] = [
    'bmsreview.test@gmail.com',   // Review Tester
    'meta-review@bemoreswan.com', // Meta app reviewer
    'mefenemer@hotmail.com',      // owner
    'mefenemer@googlemail.com',   // owner
];

/** The plan groups the admin can tick, in display order. */
export const AUDIENCE_GROUPS = ['paying', 'trial', 'beta', 'no_plan'] as const;
export type AudienceGroup = typeof AUDIENCE_GROUPS[number];
export const AUDIENCE_LABELS: Record<AudienceGroup, string> = {
    paying: 'Paying', trial: 'Free trial', beta: 'Beta testers', no_plan: 'No plan',
};

/** A plan row in one of these states is the workspace's current plan (it still has access). */
const CURRENT_PLAN = sql`('active', 'past_due', 'cancelling', 'downgrading')`;

/** A validated, de-duplicated list of groups, in display order. Throws on anything else. */
export function normaliseAudience(raw: unknown): AudienceGroup[] {
    if (!Array.isArray(raw)) throw new AudienceError('Choose who to send it to.');
    const picked = new Set<string>();
    for (const g of raw) {
        if (typeof g !== 'string' || !(AUDIENCE_GROUPS as readonly string[]).includes(g)) throw new AudienceError(`Unknown group: ${String(g)}`);
        picked.add(g);
    }
    const out = AUDIENCE_GROUPS.filter(g => picked.has(g));
    if (out.length === 0) throw new AudienceError('Tick at least one group to send it to.');
    return out;
}
export class AudienceError extends Error {}

/** null (or every group) = everyone, the list before groups existed. */
export function isEveryone(audience: readonly string[] | null | undefined): boolean {
    return !audience || AUDIENCE_GROUPS.every(g => audience.includes(g));
}

/** Does this user have a workspace whose current plan matches `typeFilter`? */
function hasPlan(typeFilter: SQL): SQL {
    return sql`EXISTS (SELECT 1 FROM user_organisations uo
                         JOIN plans pl ON pl.organisation_id = uo.organisation_id
                        WHERE uo.user_id = ${users.id} AND pl.status IN ${CURRENT_PLAN} AND ${typeFilter})`;
}
const GROUP_SQL: Record<AudienceGroup, () => SQL> = {
    paying: () => hasPlan(sql`pl.plan_type NOT IN ('beta', 'trial')`),
    trial: () => hasPlan(sql`pl.plan_type = 'trial'`),
    beta: () => hasPlan(sql`pl.plan_type = 'beta'`),
    no_plan: () => sql`NOT ${hasPlan(sql`true`)}`,
};

const isRecipient = and(
    eq(users.status, 'active'),
    eq(users.role, 'user'),
    sql`coalesce(${users.pendingDeletion}, false) = false`,
    sql`coalesce(${userProfiles.emailPreferences}->>'whats_new', 'true') <> 'false'`,
    notInArray(sql`lower(${users.email})`, [...EXCLUDED_RECIPIENT_EMAILS]),
);

function where(audience: readonly string[] | null | undefined) {
    if (isEveryone(audience)) return isRecipient;
    const groups = normaliseAudience(audience);
    return and(isRecipient, or(...groups.map(g => GROUP_SQL[g]())));
}

export async function countRecipients(db: Db, audience: readonly string[] | null = null): Promise<number> {
    const [row] = await db.select({ n: sql<number>`count(*)::int` })
        .from(users)
        .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
        .where(where(audience));
    return row?.n ?? 0;
}

/** How many recipients are in each group (a person in two workspaces can count in two groups). */
export async function countByGroup(db: Db): Promise<Record<AudienceGroup, number>> {
    const [row] = await db.select({
        paying: sql<number>`count(*) filter (where ${GROUP_SQL.paying()})::int`,
        trial: sql<number>`count(*) filter (where ${GROUP_SQL.trial()})::int`,
        beta: sql<number>`count(*) filter (where ${GROUP_SQL.beta()})::int`,
        no_plan: sql<number>`count(*) filter (where ${GROUP_SQL.no_plan()})::int`,
    }).from(users)
        .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
        .where(isRecipient);
    return { paying: row?.paying ?? 0, trial: row?.trial ?? 0, beta: row?.beta ?? 0, no_plan: row?.no_plan ?? 0 };
}

/** One page of recipients after `afterId`, in id order — the worker walks the list with this. */
export async function recipientPage(db: Db, afterId: number, limit: number, audience: readonly string[] | null = null) {
    return db.select({ id: users.id, email: users.email, firstName: users.firstName })
        .from(users)
        .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
        .where(and(where(audience), gt(users.id, afterId)))
        .orderBy(asc(users.id))
        .limit(limit);
}

// ── The chosen groups, stored on the email at approve ──────────────────────────────────────────
// product_update_digests.audience (db/z-product-update-audience.sql). Deliberately NOT in
// schema.ts: every db.select() of a digest would name the column and fail until the SQL is applied.
// NULL = everyone. A missing column reads as everyone, and only a narrower choice needs to write it.

const MISSING_COLUMN = '42703';

export async function readAudience(db: Db, digestId: number): Promise<AudienceGroup[] | null> {
    try {
        const res: any = await db.execute(sql`SELECT audience FROM product_update_digests WHERE id = ${digestId}`);
        const rows = Array.isArray(res) ? res : res?.rows ?? [];
        const a = rows[0]?.audience;
        return Array.isArray(a) && a.length ? normaliseAudience(a) : null;
    } catch (err: any) {
        if (err?.code === MISSING_COLUMN || err?.cause?.code === MISSING_COLUMN) return null;
        throw err;
    }
}

/** Writes the choice while the email is still 'ready'. Everyone = NULL, and a database without the
 *  column can still approve for everyone (there is nothing narrower to remember). */
export async function writeAudience(db: Db, digestId: number, audience: AudienceGroup[]): Promise<void> {
    const everyone = isEveryone(audience);
    const value = everyone ? sql`NULL` : sql`ARRAY[${sql.join(audience.map(g => sql`${g}`), sql`, `)}]::text[]`;
    try {
        await db.execute(sql`UPDATE product_update_digests SET audience = ${value} WHERE id = ${digestId} AND status = 'ready'`);
    } catch (err: any) {
        if (err?.code === MISSING_COLUMN || err?.cause?.code === MISSING_COLUMN) {
            if (everyone) return;
            throw new AudienceError('Sending to only some groups needs db/z-product-update-audience.sql on this database first. Tick every group, or apply the SQL.');
        }
        throw err;
    }
}
