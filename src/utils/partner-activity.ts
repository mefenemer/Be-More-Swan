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
import { DECLINED_CHANGE_DAYS, PARTNER_TERMS_EFFECTIVE, PARTNER_TERMS_VERSION } from '../config/partner-terms';

type Db = any;
type Row = Record<string, any>;

export const ACTIVE_PERIOD_MONTHS = 6;
export const STANDARD_PERIOD_MONTHS = 12;
export const RUN_OFF_MONTHS = 3;
export const FREE_MONTHS_AFTER_TRIAL = 1;
export const NOTICE_EXTENSION_DAYS = 7;
const DAY_MS = 86_400_000;

export type EndReason = 'inactivity' | 'closure' | 'left' | 'change_declined' | 'breach' | 'other';
export const END_REASONS: EndReason[] = ['inactivity', 'closure', 'left', 'change_declined', 'breach', 'other'];

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

/** Terms 7.4(a): endings that keep the run-off — leaving (7.1), declining a change (8.1), inactivity (7.5), closure (7.2). */
export const RUN_OFF_REASONS = ['left', 'change_declined', 'inactivity', 'closure'] as const;

/**
 * Does an ENDED partner still earn on this payment? (The commission window is checked separately.)
 * Terms 7.4(a): after leaving, declining a change, inactivity or closure, ≤12-month periods run to
 * term and longer (or lifetime) ones earn for 3 months after ending. 7.4(b): an ending for breach,
 * fraud or the law ('breach', 'other') earns nothing after the end date.
 */
export function runOffAllows(endReason: string | null, endedAt: Date | null, durationMonths: number | null, paidAt: Date): boolean {
    if (!endedAt || !(RUN_OFF_REASONS as readonly string[]).includes(String(endReason))) return false;
    if (durationMonths !== null && durationMonths <= STANDARD_PERIOD_MONTHS) return true;
    return paidAt.getTime() < addMonthsUtc(endedAt, RUN_OFF_MONTHS).getTime();
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

/**
 * Latest Qualifying Customer's first payment in the current partnership (§7.5(b)): not a first
 * payment made while the partner was suspended (locked_while_suspended, set by the ledger), and not
 * one whose first commission was voided (refunded / charged back / lost dispute). A first payment
 * whose commission is missing or was entered late by hand still counts — the customer did pay.
 */
async function lastQualifying(db: Db, partnerId: number, since: Date): Promise<Date | null> {
    const rows = (await db.execute(sql`
        SELECT MAX(pr.subscribed_at)::text AS at
          FROM partner_referrals pr
         WHERE pr.partner_id = ${partnerId} AND pr.subscribed_at IS NOT NULL AND pr.subscribed_at >= ${since.toISOString()}::timestamp
           AND NOT pr.locked_while_suspended
           AND COALESCE((SELECT c.status = 'voided' FROM partner_commissions c
                          WHERE c.partner_referral_id = pr.id AND c.kind = 'invoice'
                          ORDER BY c.created_at ASC LIMIT 1), FALSE) = FALSE`)) as Row[];
    const at = rows[0]?.at;
    return at ? new Date(`${String(at).replace(' ', 'T')}Z`) : null;
}

function toDate(v: unknown): Date | null {
    if (!v) return null;
    if (v instanceof Date) return v;
    const s = String(v);
    return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
}

/**
 * Where the clock counts from (owner 2026-11-24): the partnership's START — when the partner accepted the Partner
 * Terms after approval (partner_since) — or a later reinstatement (approved_at). Null = not started: no clock at all.
 */
export function clockBase(partnerSince: Date | null, approvedAt: Date | null): Date | null {
    if (!partnerSince) return null;
    return approvedAt && approvedAt.getTime() > partnerSince.getTime() ? approvedAt : partnerSince;
}

/** The clock's start (§7.5(c)): the later of the clock base and the latest Qualifying Customer. */
function clockStart(approvedAt: Date, last: Date | null): Date {
    return last && last.getTime() > approvedAt.getTime() ? last : approvedAt;
}

/** Paused days count only against the start they were counted for; a newer start resets them. */
export function pauseDaysFor(storedDays: number, storedAnchor: Date | null, start: Date): number {
    if (!storedAnchor || storedAnchor.getTime() < start.getTime() - 1000) return 0;
    return Math.max(0, storedDays);
}

export async function getPartnerActivity(db: Db, partnerId: number, now: Date = new Date()): Promise<PartnerActivity> {
    const rows = (await db.execute(sql`
        SELECT status, approved_at::text AS approved_at, partner_since::text AS partner_since, activity_pause_days,
               activity_pause_anchor::text AS pause_anchor,
               inactivity_notice_at::text AS notice_at, inactivity_notice_ends::text AS notice_ends,
               decided_at::text AS decided_at, created_at::text AS created_at
          FROM partners WHERE id = ${partnerId}`)) as Row[];
    const p = rows[0];
    const empty: PartnerActivity = { activeUntil: null, lastQualifyingAt: null, pauseDays: 0, notice: null, noticeMonths: 1, canSendNotice: false, canEnd: false };
    if (!p || !['approved', 'suspended'].includes(p.status)) return empty;
    const since = toDate(p.partner_since);
    const base = clockBase(since, toDate(p.approved_at));
    if (!since || !base) return empty;   // not started: they haven't accepted the Partner Terms since approval
    const last = await lastQualifying(db, partnerId, since);
    const pauseDays = pauseDaysFor(Number(p.activity_pause_days) || 0, toDate(p.pause_anchor), clockStart(base, last));
    const until = activeUntil(base, last, pauseDays);
    const sentAt = toDate(p.notice_at);
    const endsAt = toDate(p.notice_ends);
    // A notice from before the latest approval is stale (approvals clear it; this is belt and braces).
    const notice = sentAt && endsAt && sentAt.getTime() >= base.getTime() ? { sentAt, endsAt } : null;
    const qualifiedSinceNotice = !!(notice && last && last.getTime() >= notice.sentAt.getTime());
    const pastDate = now.getTime() >= until.getTime();
    return {
        activeUntil: until, lastQualifyingAt: last, pauseDays, notice, noticeMonths: noticeMonths(since, now),
        canSendNotice: p.status === 'approved' && !notice && pastDate,
        canEnd: p.status === 'approved' && !!notice && !qualifiedSinceNotice && pastDate && now.getTime() >= notice.endsAt.getTime(),
    };
}

// ── Notices and ending ───────────────────────────────────────────────────────────────────────

async function partnerContact(db: Db, partnerId: number): Promise<{ userId: number | null; email: string | null; firstName: string | null }> {
    const rows = (await db.execute(sql`
        SELECT p.user_id, u.email, u.first_name FROM partners p LEFT JOIN users u ON u.id = p.user_id WHERE p.id = ${partnerId}`)) as Row[];
    const r = rows[0] ?? {};
    return { userId: r.user_id ?? null, email: r.email ?? null, firstName: r.first_name ?? null };
}

/** In-app + email. Returns whether the EMAIL went (§12.2: email is the notice channel). */
async function tell(db: Db, partnerId: number, key: 'partner_inactivity_notice' | 'partner_inactivity_withdrawn', vars: Record<string, Record<string, string>>): Promise<boolean> {
    const who = await partnerContact(db, partnerId).catch(() => ({ userId: null, email: null, firstName: null }));
    if (who.userId) await createNotification(db, key, { userId: who.userId, context: vars, metadata: { action: 'partner_page' } }).catch(() => false);
    if (!who.email) return false;
    try {
        const sent = await sendTemplatedEmail({ triggerKey: key, to: who.email, vars: { ...vars, user: { first_name: who.firstName || '' }, link: { action_url: partnerPageUrl(), terms_url: termsUrl() } } });
        return !!sent;
    } catch (err) {
        console.error(`[partner-activity] ${key} email NOT sent:`, err);
        return false;
    }
}

/** An admin gives the §7.5 notice. Refused before the Active Period has ended. */
export async function sendInactivityNotice(db: Db, partnerId: number, now: Date = new Date()): Promise<{ ok: true; endsAt: Date; emailed: boolean } | { ok: false; error: string }> {
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
    const emailed = await tell(db, partnerId, 'partner_inactivity_notice', { partner: { notice_ends: ukDate(endsAt), notice_months: String(a.noticeMonths) } });
    return { ok: true, endsAt, emailed };
}

/**
 * §7.5(e): extend an open notice for sign-ups (through their link or code, in this partnership,
 * not yet paying) still in their free period when it would end. Returns the new end, or null.
 */
async function extendForFreePeriods(db: Db, partnerId: number, userId: number | null, since: Date, endsAt: Date): Promise<Date | null> {
    if (!userId) return null;
    const signUps = (await db.execute(sql`
        SELECT ur.created_at::text AS at FROM user_referrals ur
          LEFT JOIN partner_referrals pr ON pr.referral_id = ur.id
         WHERE ur.referrer_id = ${userId} AND ur.created_at >= ${since.toISOString()}::timestamp
           AND (pr.id IS NULL OR pr.subscribed_at IS NULL)`)) as Row[];
    const ext = extendedNoticeEnd(endsAt, signUps.map((r) => toDate(r.at)!));
    if (!ext) return null;
    await db.execute(sql`UPDATE partners SET inactivity_notice_ends = ${ext.toISOString()}::timestamp, updated_at = now() WHERE id = ${partnerId} AND inactivity_notice_ends = ${endsAt.toISOString()}::timestamp`);
    return ext;
}

async function partnerClockRow(db: Db, partnerId: number): Promise<Row | undefined> {
    const rows = (await db.execute(sql`
        SELECT id, user_id, COALESCE(partner_since, approved_at, decided_at, created_at)::text AS since FROM partners WHERE id = ${partnerId}`)) as Row[];
    return rows[0];
}

/** An admin ends the partnership once a notice has run out with no Qualifying Customer. */
export async function endForInactivity(db: Db, partnerId: number, adminId: number, now: Date = new Date()): Promise<{ ok: true } | { ok: false; error: string }> {
    const a = await getPartnerActivity(db, partnerId, now);
    if (!a.canEnd) {
        return { ok: false, error: a.notice ? `The notice runs until ${ukDate(a.notice.endsAt)}, or a new customer has withdrawn it.` : 'Give an inactivity notice first (Partner Terms 7.5).' };
    }
    // §7.5(e) checked NOW, not only by last night's sweep: a sign-up on the notice's last day extends it.
    const row = await partnerClockRow(db, partnerId);
    if (row && a.notice) {
        const ext = await extendForFreePeriods(db, partnerId, row.user_id ?? null, toDate(row.since)!, a.notice.endsAt);
        if (ext) return { ok: false, error: `Someone signed up through their link and is still in their free period, so the notice now runs until ${ukDate(ext)} (Partner Terms 7.5(e)).` };
    }
    const updated = (await db.execute(sql`
        UPDATE partners SET status = 'ended', ended_at = ${now.toISOString()}::timestamp, end_reason = 'inactivity', decided_by = ${adminId}, decided_at = ${now.toISOString()}::timestamp,
               decision_note = 'Ended for inactivity (Partner Terms 7.5)', inactivity_notice_at = NULL, inactivity_notice_ends = NULL, updated_at = now()
         WHERE id = ${partnerId} AND status = 'approved' RETURNING id`)) as Row[];
    if (updated.length) await db.execute(sql`DELETE FROM partner_pending_rates WHERE partner_id = ${partnerId}`);   // review of #838
    return updated.length ? { ok: true } : { ok: false, error: 'Someone else changed this partner a moment ago. Reload to see the latest.' };
}

// ── The nightly sweep ────────────────────────────────────────────────────────────────────────

/**
 * 1. §7.5(c) pause: paused days belong to the clock start they were counted for — a new start (an
 *    approval, a new Qualifying Customer) resets them to 0. Then one day per run for suspended
 *    partners, and for every approved partner while sign-ups are paused. Idempotent per day.
 * 2. §7.5(e) open notices: withdrawn on a Qualifying Customer since the notice; extended for a
 *    sign-up still in their free period when it would end.
 */
export async function sweepPartnerActivity(db: Db, now: Date = new Date(), registrationLocked = false): Promise<{ paused: number; withdrawn: number; extended: number }> {
    const today = now.toISOString().slice(0, 10);
    let paused = 0;
    let withdrawn = 0;
    let extended = 0;
    const live = (await db.execute(sql`
        SELECT id, user_id, status, activity_pause_days, activity_pause_anchor::text AS pause_anchor, activity_pause_last_day::text AS last_day,
               approved_at::text AS approved_at, partner_since::text AS since,
               inactivity_notice_at::text AS notice_at, inactivity_notice_ends::text AS notice_ends
          FROM partners WHERE status IN ('approved', 'suspended') AND partner_since IS NOT NULL`)) as Row[];
    for (const p of live) {
        const since = toDate(p.since)!;
        const last = await lastQualifying(db, p.id, since);
        const start = clockStart(clockBase(since, toDate(p.approved_at))!, last);
        let days = pauseDaysFor(Number(p.activity_pause_days) || 0, toDate(p.pause_anchor), start);
        const pausedToday = p.status === 'suspended' || (p.status === 'approved' && registrationLocked);
        const notCountedToday = !p.last_day || String(p.last_day).slice(0, 10) < today;
        if (pausedToday && notCountedToday) { days += 1; paused++; }
        await db.execute(sql`
            UPDATE partners SET activity_pause_days = ${days}, activity_pause_anchor = ${start.toISOString()}::timestamp,
                   activity_pause_last_day = ${pausedToday && notCountedToday ? today : (p.last_day ? String(p.last_day).slice(0, 10) : null)}::date
             WHERE id = ${p.id}`);

        if (p.status !== 'approved' || !p.notice_at) continue;
        const sentAt = toDate(p.notice_at)!;
        const endsAt = toDate(p.notice_ends)!;
        if (last && last.getTime() >= sentAt.getTime()) {
            await db.execute(sql`UPDATE partners SET inactivity_notice_at = NULL, inactivity_notice_ends = NULL, updated_at = now() WHERE id = ${p.id}`);
            await tell(db, p.id, 'partner_inactivity_withdrawn', { partner: { first_payment_on: ukDate(last) } });
            withdrawn++;
            continue;
        }
        if (now.getTime() < endsAt.getTime() - 8 * DAY_MS) continue;
        if (await extendForFreePeriods(db, p.id, p.user_id ?? null, since, endsAt)) extended++;
    }
    return { paused, withdrawn, extended };
}

/**
 * Terms 8.1: a partner who accepted an earlier version but has not accepted the current one within 60
 * days of it taking effect is treated as leaving (7.1) — ended with end_reason 'change_declined', which
 * keeps the 7.4(a) run-off. Partners who never accepted any version (terms_version NULL) are untouched.
 */
/**
 * Terms 8.1: the day a partner on an older version is treated as leaving — 60 days after the LATER of the version
 * taking effect and the partner's latest approval (review of #823: a partner approved, re-approved or reinstated
 * after the version date gets their own 60 days, never an ending on the night of approval).
 */
export function declinedChangeDeadline(effectiveIso: string, approvedAt: Date | null): Date {
    const effective = new Date(`${effectiveIso}T00:00:00Z`);
    const from = approvedAt && approvedAt.getTime() > effective.getTime() ? approvedAt : effective;
    return new Date(from.getTime() + DECLINED_CHANGE_DAYS * DAY_MS);
}

export async function endDeclinedChanges(db: Db, now: Date = new Date()): Promise<{ ended: number }> {
    // No effective date for the current version = someone bumped the version without dating it: do nothing.
    if (!PARTNER_TERMS_EFFECTIVE) {
        console.error(`[partner-activity] Partner Terms v${PARTNER_TERMS_VERSION} has no date in PARTNER_TERMS_EFFECTIVE_DATES — declined-change sweep skipped`);
        return { ended: 0 };
    }
    const deadline = new Date(new Date(`${PARTNER_TERMS_EFFECTIVE}T00:00:00Z`).getTime() + DECLINED_CHANGE_DAYS * DAY_MS);
    if (now.getTime() < deadline.getTime()) return { ended: 0 };
    // Approved partners only: a suspended partner is under investigation, and ending them here would give them a
    // run-off a breach ending (7.4(b)) would not — an admin decides their case.
    const rows = (await db.execute(sql`
        UPDATE partners SET status = 'ended', ended_at = ${now.toISOString()}::timestamp, end_reason = 'change_declined',
               decided_at = ${now.toISOString()}::timestamp,
               decision_note = ${`Did not accept Partner Terms v${PARTNER_TERMS_VERSION} within ${DECLINED_CHANGE_DAYS} days (Terms 8.1)`},
               inactivity_notice_at = NULL, inactivity_notice_ends = NULL, updated_at = now()
         WHERE status = 'approved' AND terms_version IS NOT NULL AND terms_version <> ${PARTNER_TERMS_VERSION}
           -- the partner's own 60 days from their latest approval (declinedChangeDeadline)
           AND COALESCE(approved_at, decided_at, created_at) <= ${new Date(now.getTime() - DECLINED_CHANGE_DAYS * DAY_MS).toISOString()}::timestamp
         RETURNING id, terms_version`)) as Row[];
    for (const r of rows) {
        // An ended partner's special rate still waiting to start goes too (as on an admin end — review of #838).
        await db.execute(sql`DELETE FROM partner_pending_rates WHERE partner_id = ${r.id}`);
        // A system decision: an audit row with no admin, and the partner is told (Terms 12.2 — notice by email).
        await db.execute(sql`
            INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, previous_state, new_state)
            VALUES (NULL, 'partner_decision', 'partner', ${String(r.id)},
                    ${JSON.stringify({ status: 'approved', termsVersion: r.terms_version })}::jsonb,
                    ${JSON.stringify({ status: 'ended', endReason: 'change_declined', by: 'nightly sweep', version: PARTNER_TERMS_VERSION })}::jsonb)`)
            .catch((err: unknown) => console.error('[partner-activity] audit row for change_declined failed', err));
        await tellEnded(db, r.id);
    }
    return { ended: rows.length };
}

async function tellEnded(db: Db, partnerId: number): Promise<void> {
    const who = await partnerContact(db, partnerId).catch(() => ({ userId: null, email: null, firstName: null }));
    const vars = { partner: { version: PARTNER_TERMS_VERSION, days: String(DECLINED_CHANGE_DAYS) } };
    if (who.userId) await createNotification(db, 'partner_ended_change_declined', { userId: who.userId, context: vars, metadata: { action: 'partner_page' } }).catch(() => false);
    if (who.email) {
        await sendTemplatedEmail({ triggerKey: 'partner_ended_change_declined', to: who.email, vars: { ...vars, user: { first_name: who.firstName || '' }, link: { action_url: partnerPageUrl(), terms_url: termsUrl() } } })
            .catch((err: unknown) => console.error('[partner-activity] change_declined email NOT sent', err));
    }
}
