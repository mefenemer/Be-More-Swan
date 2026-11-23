// src/utils/partner-activity.ts
// Partner Terms 1.3 §7.5 "Staying active" — the activity clock, inactivity notices, and the run-off
// after a partnership ends (§7.2 closure, §7.5(h) inactivity). docs/legal/partner-terms-v1.3-activity-draft.md.
// Columns: db/z-partner-activity.sql.
//
//   Active Period   6 months from the later of the most recent approval and the most recent Qualifying
//                   Customer's first payment, plus any paused days (suspended, or sign-ups paused).
//   Qualifying      a customer of THIS partnership (first paid on/after partner_since) whose first
//                   payment earned a commission that has not been voided (refunded / charged back / lost).
//   Notice          only an admin sends it, only once the Active Period has ended; 1 / 2 / 3 months by
//                   tenure. Withdrawn by the nightly sweep on a Qualifying Customer; extended for a
//                   sign-up still in their free period; never ends a partnership by itself — an admin
//                   ends it once the notice has run out (internal policy: same treatment for everyone).
//   Run-off         after ending for inactivity: customers on a ≤12-month period run to term; longer
//                   periods earn for 3 more months. After closure: 3 months. Any other ending: none (7.4).

import { sql } from 'drizzle-orm';
import { addMonthsUtc } from './partner-rate-periods';
import { TRIAL_DAYS } from './trial';
import { createNotification } from './notify';
import { sendTemplatedEmail } from './email';

type Db = any;
type Row = Record<string, any>;

export const ACTIVE_PERIOD_MONTHS = 6;
export const STANDARD_PERIOD_MONTHS = 12;
export const RUN_OFF_MONTHS = 3;
export const FREE_MONTHS_AFTER_TRIAL = 1;
export const NOTICE_EXTENSION_DAYS = 7;
const DAY_MS = 86_400_000;

export type EndReason = 'inactivity' | 'closure' | 'left' | 'breach' | 'other';
export const END_REASONS: EndReason[] = ['inactivity', 'closure', 'left', 'breach', 'other'];

const ukDate = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });
const partnerPageUrl = () => `${(process.env.BASE_URL || 'https://bemoreswan.com').replace(/\/$/, '')}/workspace.html?view=partner`;
const termsUrl = () => `${(process.env.BASE_URL || 'https://bemoreswan.com').replace(/\/$/, '')}/partner-terms.html#staying-active`;

// ── Pure rules ───────────────────────────────────────────────────────────────────────────────

/** §7.5(c): the day the Active Period ends. */
export function activeUntil(approvedAt: Date, lastQualifyingAt: Date | null, pauseDays: number): Date {
    const from = lastQualifyingAt && lastQualifyingAt.getTime() > approvedAt.getTime() ? lastQualifyingAt : approvedAt;
    return new Date(addMonthsUtc(from, ACTIVE_PERIOD_MONTHS).getTime() + Math.max(0, pauseDays) * DAY_MS);
}

/** §7.5(d): 1 month, 2 after a year as a partner, 3 after two years. */
export function noticeMonths(partnerSince: Date, now: Date): number {
    if (addMonthsUtc(partnerSince, 24).getTime() < now.getTime()) return 3;
    if (addMonthsUtc(partnerSince, 12).getTime() < now.getTime()) return 2;
    return 1;
}

/** When a sign-up's free period (trial, then the first month free) ends. */
export function freePeriodEnd(signedUpAt: Date): Date {
    return addMonthsUtc(new Date(signedUpAt.getTime() + TRIAL_DAYS * DAY_MS), FREE_MONTHS_AFTER_TRIAL);
}

/**
 * §7.5(e): sign-ups made before the notice ends and still in their free period when it would end
 * push it to 7 days after the latest such free period. Null = no extension.
 */
export function extendedNoticeEnd(noticeEnds: Date, signUps: Date[]): Date | null {
    let latest: Date | null = null;
    for (const at of signUps) {
        if (at.getTime() >= noticeEnds.getTime()) continue;
        const free = freePeriodEnd(at);
        if (free.getTime() <= noticeEnds.getTime()) continue;
        const ext = new Date(free.getTime() + NOTICE_EXTENSION_DAYS * DAY_MS);
        if (!latest || ext.getTime() > latest.getTime()) latest = ext;
    }
    return latest && latest.getTime() > noticeEnds.getTime() ? latest : null;
}

/**
 * Does an ENDED partner still earn on this payment? (The commission window is checked separately.)
 * §7.5(h) inactivity: ≤12-month periods run to term; longer (or lifetime) ones for 3 months after ending.
 * §7.2 closure: 3 months after closure. Anything else: nothing after the end date (§7.4).
 */
export function runOffAllows(endReason: string | null, endedAt: Date | null, durationMonths: number | null, paidAt: Date): boolean {
    if (!endedAt) return false;
    const threeMonths = paidAt.getTime() < addMonthsUtc(endedAt, RUN_OFF_MONTHS).getTime();
    if (endReason === 'inactivity') {
        if (durationMonths !== null && durationMonths <= STANDARD_PERIOD_MONTHS) return true;
        return threeMonths;
    }
    if (endReason === 'closure') return threeMonths;
    return false;
}

// ── Reading the clock ────────────────────────────────────────────────────────────────────────

export interface PartnerActivity {
    activeUntil: Date | null;          // null = not an approved partner with a clock
    lastQualifyingAt: Date | null;
    pauseDays: number;
    notice: { sentAt: Date; endsAt: Date } | null;
    noticeMonths: number;
    canSendNotice: boolean;            // Active Period over, no notice open (§7.5(g): never before the date shown)
    canEnd: boolean;                   // a notice has run out with no Qualifying Customer
}

/** Latest Qualifying Customer's first payment in the current partnership. */
async function lastQualifying(db: Db, partnerId: number, since: Date): Promise<Date | null> {
    const rows = (await db.execute(sql`
        SELECT MAX(pr.subscribed_at)::text AS at
          FROM partner_referrals pr
         WHERE pr.partner_id = ${partnerId} AND pr.subscribed_at IS NOT NULL AND pr.subscribed_at >= ${since.toISOString()}::timestamp
           AND EXISTS (SELECT 1 FROM partner_commissions c
                        WHERE c.partner_referral_id = pr.id AND c.kind = 'invoice' AND c.status <> 'voided')`)) as Row[];
    const at = rows[0]?.at;
    return at ? new Date(`${String(at).replace(' ', 'T')}Z`) : null;
}

function toDate(v: unknown): Date | null {
    if (!v) return null;
    if (v instanceof Date) return v;
    const s = String(v);
    return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
}

export async function getPartnerActivity(db: Db, partnerId: number, now: Date = new Date()): Promise<PartnerActivity> {
    const rows = (await db.execute(sql`
        SELECT status, approved_at::text AS approved_at, partner_since::text AS partner_since, activity_pause_days,
               inactivity_notice_at::text AS notice_at, inactivity_notice_ends::text AS notice_ends,
               decided_at::text AS decided_at, created_at::text AS created_at
          FROM partners WHERE id = ${partnerId}`)) as Row[];
    const p = rows[0];
    const empty: PartnerActivity = { activeUntil: null, lastQualifyingAt: null, pauseDays: 0, notice: null, noticeMonths: 1, canSendNotice: false, canEnd: false };
    if (!p || !['approved', 'suspended'].includes(p.status)) return empty;
    const approvedAt = toDate(p.approved_at) ?? toDate(p.decided_at) ?? toDate(p.created_at)!;
    const since = toDate(p.partner_since) ?? approvedAt;
    const last = await lastQualifying(db, partnerId, since);
    const pauseDays = Number(p.activity_pause_days) || 0;
    const until = activeUntil(approvedAt, last, pauseDays);
    const sentAt = toDate(p.notice_at);
    const endsAt = toDate(p.notice_ends);
    const notice = sentAt && endsAt ? { sentAt, endsAt } : null;
    const qualifiedSinceNotice = !!(notice && last && last.getTime() >= notice.sentAt.getTime());
    return {
        activeUntil: until, lastQualifyingAt: last, pauseDays, notice, noticeMonths: noticeMonths(since, now),
        canSendNotice: p.status === 'approved' && !notice && now.getTime() >= until.getTime(),
        canEnd: p.status === 'approved' && !!notice && !qualifiedSinceNotice && now.getTime() >= notice.endsAt.getTime(),
    };
}

// ── Notices and ending ───────────────────────────────────────────────────────────────────────

async function partnerContact(db: Db, partnerId: number): Promise<{ userId: number | null; email: string | null; firstName: string | null }> {
    const rows = (await db.execute(sql`
        SELECT p.user_id, u.email, u.first_name FROM partners p LEFT JOIN users u ON u.id = p.user_id WHERE p.id = ${partnerId}`)) as Row[];
    const r = rows[0] ?? {};
    return { userId: r.user_id ?? null, email: r.email ?? null, firstName: r.first_name ?? null };
}

async function tell(db: Db, partnerId: number, key: 'partner_inactivity_notice' | 'partner_inactivity_withdrawn', vars: Record<string, Record<string, string>>): Promise<void> {
    try {
        const who = await partnerContact(db, partnerId);
        if (who.userId) await createNotification(db, key, { userId: who.userId, context: vars, metadata: { action: 'partner_page' } });
        // §12.2: notice is given by email.
        if (who.email) await sendTemplatedEmail({ triggerKey: key, to: who.email, vars: { ...vars, user: { first_name: who.firstName || '' }, link: { action_url: partnerPageUrl(), terms_url: termsUrl() } } });
    } catch (err) {
        console.error(`[partner-activity] ${key} not sent (non-blocking):`, err);
    }
}

/** An admin gives the §7.5 notice. Refused before the Active Period has ended. */
export async function sendInactivityNotice(db: Db, partnerId: number, now: Date = new Date()): Promise<{ ok: true; endsAt: Date } | { ok: false; error: string }> {
    const a = await getPartnerActivity(db, partnerId, now);
    if (a.notice) return { ok: false, error: `A notice is already open until ${ukDate(a.notice.endsAt)}.` };
    if (!a.canSendNotice) {
        return { ok: false, error: a.activeUntil ? `Their Active Period runs until ${ukDate(a.activeUntil)} — no notice before then (Partner Terms 7.5(g)).` : 'Only an approved partner can be given notice.' };
    }
    const endsAt = addMonthsUtc(now, a.noticeMonths);
    const updated = (await db.execute(sql`
        UPDATE partners SET inactivity_notice_at = ${now.toISOString()}::timestamp, inactivity_notice_ends = ${endsAt.toISOString()}::timestamp, updated_at = now()
         WHERE id = ${partnerId} AND status = 'approved' AND inactivity_notice_at IS NULL RETURNING id`)) as Row[];
    if (!updated.length) return { ok: false, error: 'Someone else changed this partner a moment ago. Reload to see the latest.' };
    await tell(db, partnerId, 'partner_inactivity_notice', { partner: { notice_ends: ukDate(endsAt), notice_months: String(a.noticeMonths) } });
    return { ok: true, endsAt };
}

/** An admin ends the partnership once a notice has run out with no Qualifying Customer. */
export async function endForInactivity(db: Db, partnerId: number, adminId: number, now: Date = new Date()): Promise<{ ok: true } | { ok: false; error: string }> {
    const a = await getPartnerActivity(db, partnerId, now);
    if (!a.canEnd) {
        return { ok: false, error: a.notice ? `The notice runs until ${ukDate(a.notice.endsAt)}, or a new customer has withdrawn it.` : 'Give an inactivity notice first (Partner Terms 7.5).' };
    }
    const updated = (await db.execute(sql`
        UPDATE partners SET status = 'ended', ended_at = ${now.toISOString()}::timestamp, end_reason = 'inactivity', decided_by = ${adminId}, decided_at = ${now.toISOString()}::timestamp,
               decision_note = 'Ended for inactivity (Partner Terms 7.5)', inactivity_notice_at = NULL, inactivity_notice_ends = NULL, updated_at = now()
         WHERE id = ${partnerId} AND status = 'approved' RETURNING id`)) as Row[];
    return updated.length ? { ok: true } : { ok: false, error: 'Someone else changed this partner a moment ago. Reload to see the latest.' };
}

// ── The nightly sweep ────────────────────────────────────────────────────────────────────────

/**
 * 1. §7.5(c) pause: one day per run for suspended partners, and for every approved partner while
 *    sign-ups are paused (the registration lock). Idempotent per calendar day.
 * 2. §7.5(e) open notices: withdrawn on a Qualifying Customer since the notice; extended for a
 *    sign-up still in their free period when it would end.
 */
export async function sweepPartnerActivity(db: Db, now: Date = new Date(), registrationLocked = false): Promise<{ paused: number; withdrawn: number; extended: number }> {
    const today = now.toISOString().slice(0, 10);
    const pausedRows = (await db.execute(sql`
        UPDATE partners SET activity_pause_days = activity_pause_days + 1, activity_pause_last_day = ${today}::date
         WHERE (activity_pause_last_day IS NULL OR activity_pause_last_day < ${today}::date)
           AND (status = 'suspended' OR (status = 'approved' AND ${registrationLocked}))
         RETURNING id`)) as Row[];

    let withdrawn = 0;
    let extended = 0;
    const open = (await db.execute(sql`
        SELECT id, user_id, inactivity_notice_at::text AS notice_at, inactivity_notice_ends::text AS notice_ends,
               COALESCE(partner_since, approved_at, decided_at, created_at)::text AS since
          FROM partners WHERE status = 'approved' AND inactivity_notice_at IS NOT NULL`)) as Row[];
    for (const p of open) {
        const sentAt = toDate(p.notice_at)!;
        const endsAt = toDate(p.notice_ends)!;
        const last = await lastQualifying(db, p.id, toDate(p.since)!);
        if (last && last.getTime() >= sentAt.getTime()) {
            await db.execute(sql`UPDATE partners SET inactivity_notice_at = NULL, inactivity_notice_ends = NULL, updated_at = now() WHERE id = ${p.id}`);
            await tell(db, p.id, 'partner_inactivity_withdrawn', { partner: { first_payment_on: ukDate(last) } });
            withdrawn++;
            continue;
        }
        if (now.getTime() < endsAt.getTime() - 8 * DAY_MS || !p.user_id) continue;
        // Sign-ups through their link or code since the notice that haven't paid yet.
        const signUps = (await db.execute(sql`
            SELECT ur.created_at::text AS at FROM user_referrals ur
              LEFT JOIN partner_referrals pr ON pr.referral_id = ur.id
             WHERE ur.referrer_id = ${p.user_id} AND ur.created_at >= ${toDate(p.since)!.toISOString()}::timestamp
               AND (pr.id IS NULL OR pr.subscribed_at IS NULL)`)) as Row[];
        const ext = extendedNoticeEnd(endsAt, signUps.map((r) => toDate(r.at)!));
        if (ext) {
            await db.execute(sql`UPDATE partners SET inactivity_notice_ends = ${ext.toISOString()}::timestamp, updated_at = now() WHERE id = ${p.id} AND inactivity_notice_ends = ${endsAt.toISOString()}::timestamp`);
            extended++;
        }
    }
    return { paused: pausedRows.length, withdrawn, extended };
}
