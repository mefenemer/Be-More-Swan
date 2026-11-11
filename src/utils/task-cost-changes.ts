// src/utils/task-cost-changes.ts — changing what work costs: draft → announce → in force, with acceptance.
//
// Owner decisions, 2026-11-06:
//   · A super admin sets costs in Admin → Money → Task costs. Nothing is decided in code.
//   · Every change is announced to customers by broadcast (in-app and email), and asks for acceptance.
//   · The new cost applies to everyone on its date. A workspace owner who has not accepted by then sees a
//     prompt they cannot dismiss (accept, or go to Billing to cancel: terms 20.2, 20.3). Scheduled work
//     keeps running, because an unanswered prompt must not be what silently stops an assistant.
//   · The workspace owner accepts, once, for the whole workspace. Everyone gets the notice.
//
// A rise needs at least 30 days' notice (terms 5.2). A reduction can start sooner.
//
// A cost nobody is charged yet (chat before BASIC_WORK_CHARGED_FROM is set, say) has nothing to announce,
// so it is saved directly as a baseline: see costInUse below.

import { sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import {
    COST_KEY_LABELS, MAX_COST, basicWorkCharged, costValue, formatCost, isCostKey, isCostRise, minCost, videoPricedBySecond,
    type CostKey, type TaskCosts,
} from '../config/task-weights';
import { switchScheduled } from '../config/dated-switch';
import { LIVE_PLAN_STATUSES, type Recipient } from './broadcast';

type Db = ReturnType<typeof getDb>;

export const MIN_NOTICE_DAYS_FOR_RISE = 30;
const REASON_MIN = 10;
const REASON_MAX = 600;

/** Costs behind the "basic work" switch (docs/basic-work-charging.md). */
const BASIC_WORK_KEYS: readonly CostKey[] = ['chat_messages', 'chat_messages_per_task', 'editing_helper', 'design_round', 'finished_design'];

/**
 * Is anyone charged this cost, or told they will be? False means no customer can be affected, so a change
 * needs no notice. A switch set to a future date counts as in use: that notice has already gone out.
 */
export function costInUse(key: CostKey, now: Date = new Date()): boolean {
    if (BASIC_WORK_KEYS.includes(key)) return basicWorkCharged(now) || switchScheduled(process.env.BASIC_WORK_CHARGED_FROM);
    if (key === 'ai_video_per_second') return videoPricedBySecond(now) || switchScheduled(process.env.AI_VIDEO_PRICED_BY_SECOND);
    if (key === 'ai_video') return !videoPricedBySecond(now);
    return true;
}

export interface ChangeItem { key: CostKey; oldUnits: number; newUnits: number }

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const utcDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

/** The first date a change may start, as YYYY-MM-DD. */
export function earliestStart(rises: boolean, now: Date = new Date()): string {
    return new Date(utcDay(now) + (rises ? MIN_NOTICE_DAYS_FOR_RISE : 1) * DAY_MS).toISOString().slice(0, 10);
}

export function checkCostValue(key: CostKey, value: unknown): string | null {
    if (!Number.isInteger(value)) return `${COST_KEY_LABELS[key]} must be a whole number.`;
    const n = value as number;
    if (n < minCost(key) || n > MAX_COST) return `${COST_KEY_LABELS[key]} must be between ${minCost(key)} and ${MAX_COST}.`;
    return null;
}

/** Everything a change must satisfy to be saved or announced. Pure. */
export function validateChange(
    input: { items?: unknown; effectiveDate?: unknown; reason?: unknown },
    current: TaskCosts,
    now: Date = new Date(),
): { ok: true; items: ChangeItem[]; effectiveDate: string; reason: string; rises: boolean } | { ok: false; error: string } {
    if (!input.items || typeof input.items !== 'object') return { ok: false, error: 'Change at least one cost.' };
    const items: ChangeItem[] = [];
    for (const [key, value] of Object.entries(input.items as Record<string, unknown>)) {
        if (!isCostKey(key)) return { ok: false, error: `Unknown cost: ${key}.` };
        const bad = checkCostValue(key, value);
        if (bad) return { ok: false, error: bad };
        const oldUnits = costValue(current, key);
        if (value === oldUnits) continue;
        if (!costInUse(key, now)) return { ok: false, error: `Nobody is charged for ${COST_KEY_LABELS[key]} yet, so it needs no notice. Use its own Save button instead.` };
        items.push({ key, oldUnits, newUnits: value as number });
    }
    if (!items.length) return { ok: false, error: 'Change at least one cost.' };

    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (reason.length < REASON_MIN) return { ok: false, error: 'Say why the cost is changing. Customers read this in the notice.' };
    if (reason.length > REASON_MAX) return { ok: false, error: `Keep the reason under ${REASON_MAX} characters.` };

    const effectiveDate = typeof input.effectiveDate === 'string' ? input.effectiveDate.trim() : '';
    if (!DATE_ONLY.test(effectiveDate) || Number.isNaN(Date.parse(`${effectiveDate}T00:00:00Z`))) return { ok: false, error: 'Choose the date the change starts.' };
    const rises = items.some((i) => isCostRise(i.key, i.oldUnits, i.newUnits));
    const earliest = earliestStart(rises, now);
    if (effectiveDate < earliest) {
        return { ok: false, error: rises
            ? `A cost going up needs ${MIN_NOTICE_DAYS_FOR_RISE} days' notice (terms 5.2), so the earliest start is ${longDate(earliest)}.`
            : `The earliest start is ${longDate(earliest)}.` };
    }
    return { ok: true, items, effectiveDate, reason, rises };
}

export function longDate(iso: string): string {
    return new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** One line per cost, for the notice and the prompt: "AI music: 20 tasks → 25 tasks." */
export function changeSummary(items: ReadonlyArray<{ key: string; oldUnits: number | null; newUnits: number }>): string {
    return items.filter((i) => isCostKey(i.key)).map((i) => {
        const key = i.key as CostKey;
        return `${COST_KEY_LABELS[key]}: ${i.oldUnits === null ? '' : `${formatCost(key, i.oldUnits)} → `}${formatCost(key, i.newUnits)}.`;
    }).join(' ');
}

/** The notification type that marks who has a change's notice (once each, like every broadcast). */
export const noticeKey = (changeId: number) => `task_cost_change_${changeId}`;
export const cancelledNoticeKey = (changeId: number) => `task_cost_change_${changeId}_cancelled`;

// ── Reading ─────────────────────────────────────────────────────────────────────────────────────────

export interface ChangeRow {
    id: number;
    status: string;
    effectiveDate: string;
    reason: string;
    announcedAt: string | null;
    createdAt: string;
    items: Array<{ key: string; oldUnits: number | null; newUnits: number }>;
}

type RawChange = { id: number; status: string; effective_from: string; reason: string; announced_at: string | null; created_at: string; items: unknown };

const mapChange = (r: RawChange): ChangeRow => ({
    id: Number(r.id),
    status: r.status,
    effectiveDate: r.effective_from.slice(0, 10),
    reason: r.reason,
    announcedAt: r.announced_at,
    createdAt: r.created_at,
    items: (typeof r.items === 'string' ? JSON.parse(r.items) : (r.items ?? [])) as ChangeRow['items'],
});

const CHANGE_COLUMNS = sql`c.id, c.status, c.effective_from::text AS effective_from, c.reason, c.announced_at::text AS announced_at, c.created_at::text AS created_at,
    COALESCE((SELECT json_agg(json_build_object('key', i.cost_key, 'oldUnits', i.old_units, 'newUnits', i.new_units) ORDER BY i.cost_key)
                FROM task_cost_change_items i WHERE i.change_id = c.id), '[]'::json) AS items`;

export async function readChange(db: Db, id: number): Promise<ChangeRow | null> {
    const rows = await db.execute<RawChange>(sql`SELECT ${CHANGE_COLUMNS} FROM task_cost_changes c WHERE c.id = ${id} LIMIT 1`);
    const row = (rows as unknown as RawChange[])[0];
    return row ? mapChange(row) : null;
}

/** Newest first, leaving out the starting costs. */
export async function listChanges(db: Db, limit = 30): Promise<ChangeRow[]> {
    const rows = await db.execute<RawChange>(sql`
        SELECT ${CHANGE_COLUMNS} FROM task_cost_changes c
         WHERE c.status <> 'baseline' ORDER BY c.id DESC LIMIT ${limit}`);
    return (rows as unknown as RawChange[]).map(mapChange);
}

/** A draft, or an announced change still to start. Only one at a time: a second would quote stale "from" figures. */
export async function openChange(db: Db): Promise<ChangeRow | null> {
    const rows = await db.execute<RawChange>(sql`
        SELECT ${CHANGE_COLUMNS} FROM task_cost_changes c
         WHERE c.status = 'draft' OR (c.status = 'announced' AND c.effective_from > (now() AT TIME ZONE 'UTC'))
         ORDER BY c.id DESC LIMIT 1`);
    const row = (rows as unknown as RawChange[])[0];
    return row ? mapChange(row) : null;
}

/** The announced change still to start, for chat to mention. Null when there is none, or on a fault. */
export async function upcomingChange(db: Db): Promise<ChangeRow | null> {
    try {
        const open = await openChange(db);
        return open?.status === 'announced' ? open : null;
    } catch {
        return null;
    }
}

// ── Who must accept ─────────────────────────────────────────────────────────────────────────────────
// A workspace that signed up after the notice agreed to the costs on the pricing page that day, so it is
// not asked. Plan statuses match who gets the broadcast (LIVE_PLAN_STATUSES).

const livePlans = sql.join(LIVE_PLAN_STATUSES.map((s) => sql`${s}`), sql`, `);

/** Announced changes this workspace has not accepted, oldest first. */
export async function unacceptedChanges(db: Db, organisationId: number): Promise<ChangeRow[]> {
    const rows = await db.execute<RawChange>(sql`
        SELECT ${CHANGE_COLUMNS}
          FROM task_cost_changes c
          JOIN organisations o ON o.id = ${organisationId}
         WHERE c.status = 'announced'
           AND c.announced_at >= o.created_at
           AND EXISTS (SELECT 1 FROM plans p WHERE p.organisation_id = o.id AND p.status IN (${livePlans}))
           AND NOT EXISTS (SELECT 1 FROM task_cost_acceptances a WHERE a.change_id = c.id AND a.organisation_id = o.id)
         ORDER BY c.effective_from, c.id`);
    return (rows as unknown as RawChange[]).map(mapChange);
}

/** Record the owner's acceptance. Safe to repeat. Returns how many of `ids` this workspace could accept. */
export async function acceptChanges(db: Db, args: { organisationId: number; userId: number; ids: number[]; ipAddress: string | null; userAgent: string | null }): Promise<number> {
    const open = await unacceptedChanges(db, args.organisationId);
    const accept = open.filter((c) => args.ids.includes(c.id));
    for (const c of accept) {
        await db.execute(sql`
            INSERT INTO task_cost_acceptances (change_id, organisation_id, user_id, ip_address, user_agent)
            VALUES (${c.id}, ${args.organisationId}, ${args.userId}, ${args.ipAddress}, ${args.userAgent})
            ON CONFLICT (change_id, organisation_id) DO NOTHING`);
    }
    return accept.length;
}

export interface AcceptanceStats {
    workspaces: number;
    accepted: number;
    /** Workspaces still to accept, for following up. */
    waiting: Array<{ id: number; name: string | null; ownerEmail: string | null }>;
}

export async function acceptanceStats(db: Db, change: ChangeRow): Promise<AcceptanceStats> {
    const rows = await db.execute<{ id: number; name: string | null; owner_email: string | null; accepted: boolean }>(sql`
        SELECT o.id, o.name,
               (SELECT u.email FROM user_organisations uo JOIN users u ON u.id = uo.user_id
                 WHERE uo.organisation_id = o.id AND uo.role = 'owner' ORDER BY uo.joined_at LIMIT 1) AS owner_email,
               EXISTS (SELECT 1 FROM task_cost_acceptances a WHERE a.change_id = ${change.id} AND a.organisation_id = o.id) AS accepted
          FROM organisations o
         WHERE o.created_at <= ${change.announcedAt}::timestamp
           AND EXISTS (SELECT 1 FROM plans p WHERE p.organisation_id = o.id AND p.status IN (${livePlans}))
         ORDER BY o.id`);
    const all = rows as unknown as Array<{ id: number; name: string | null; owner_email: string | null; accepted: boolean }>;
    return {
        workspaces: all.length,
        accepted: all.filter((r) => r.accepted).length,
        waiting: all.filter((r) => !r.accepted).map((r) => ({ id: Number(r.id), name: r.name, ownerEmail: r.owner_email })),
    };
}

// ── The broadcast ───────────────────────────────────────────────────────────────────────────────────

/** Everyone who had a change's notice and has not heard it was withdrawn. */
export async function cancelledRecipients(db: Db, changeId: number): Promise<Recipient[]> {
    const rows = await db.execute<{ id: number; email: string; first_name: string | null }>(sql`
        SELECT DISTINCT u.id, u.email, u.first_name
          FROM users u
          JOIN notifications sent ON sent.user_id = u.id AND sent.type = ${noticeKey(changeId)}
         WHERE u.status = 'active'
           AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = u.id AND n.type = ${cancelledNoticeKey(changeId)})
         ORDER BY u.id`);
    return (rows as unknown as Array<{ id: number; email: string; first_name: string | null }>)
        .map((r) => ({ id: Number(r.id), email: r.email, firstName: r.first_name }));
}

/** What the notice's templates merge in. Everything but the reason comes from numbers and fixed labels. */
export function noticeContext(change: Pick<ChangeRow, 'id' | 'effectiveDate' | 'reason' | 'items'>, baseUrl: string) {
    return {
        change: {
            id: change.id,
            date: longDate(change.effectiveDate),
            summary: changeSummary(change.items),
            reason: change.reason,
            review_url: `${baseUrl}/workspace.html?review=task-costs`,
        },
    };
}
