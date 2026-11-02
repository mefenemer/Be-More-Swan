// src/utils/mentor-morning.ts
// The Business Mentor's morning summary (docs/morning-summary-plan.md). Owner decisions 2026-11-02: the
// Mentor sends it (D1); on in the app, email opt-in (D2); whoever is emailed it skips the 09:00 "actions
// waiting" email that day (D3); "Make next" by rule, never a model (D4); 07:00 in the workspace's time
// zone (D5).
//
// WHEN: dispatchMornings, called hourly by dispatch-mentor-mornings.ts (production) and
// run-mentor-morning-dispatch.ts (staging, from .github/workflows/staging-crons.yml). A workspace is due
// from 07:00 to 11:59 its local time (booking_settings.timezone, Europe/London when unset) — an hour that
// is missed is caught up, but a summary is never sent in the afternoon. One per workspace per local day:
// the mentor_mornings row is written FIRST, as the latch. Skipped: Quiet mode, the summary switched off,
// no paid plan (business-mentor-plan §2.7).
//
// WHAT IT READS — all facts, each section left out when it has nothing:
//   Yesterday     website sales (site_orders), deposits paid (bookings), deals marked won (revenue_events,
//                 only while the Lead Generator is ACTIVE, as mentor-customers.ts reads them)
//   Today         confirmed bookings starting today; booking requests waiting for a yes
//   Enquiries     website enquiries not yet marked done
//   Needs you     social posts awaiting review (awaiting-review.ts, one per card), actions held for approval
//                 (pending_actions — so the 09:00 digest can skip whoever was emailed this), open Mentor suggestions
//   Make next     the best-performing post of the last 14 days (post_insights), when its assistant is ACTIVE
// "Which calls turned into sales" is never claimed: we only see what was booked, bought or marked won.
//
// WHAT IT WRITES: one message in each owner's and admin's chat with the Mentor, an in-app notification
// (`mentor_morning_summary`) and, when they switched it on, an email. Built by rules: no model, no task.
// A day with nothing to say sends nothing (row status 'empty').

import { and, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import {
    aiAssistants, bookings, bookingSettings, chatMessages, chatSessions, masterAssistants, mentorMornings, organisations, pendingActions,
    postInsights, revenueEvents, scheduledPosts, siteEnquiries, siteOrders,
} from '../../db/schema';
import { addDays, utcToZoned, zonedToUtc, formatDate } from './booking-time';
import { awaitingReview, reviewCardKey } from './awaiting-review';
import { MENTOR_ROLE_KEY } from './mentor-provision';
import { teamState } from './mentor-snapshot';
import { loadOpenProposals } from './mentor-proposals';
import { mentorChatFor, mentorReviewLink, recipients } from './mentor-review';
import { getTaskUsage } from './work-metering';
import { createNotification } from './notify';
import { isEmailEnabled } from './notification-prefs';
import { sendTemplatedEmail } from './email';
import { recordPlatformIncident } from './platform-incident';
import { resolveBaseUrl } from './base-url';

type Db = any;

/** Local hour the summary goes out from, and the last hour it may still go (a missed tick is caught up). */
export const SEND_FROM_HOUR = 7;
export const SEND_UNTIL_HOUR = 11;
export const DEFAULT_TIME_ZONE = 'Europe/London';
/** mentor_mornings rows older than this are deleted by the dispatcher. */
export const RETAIN_DAYS = 30;
/** "Make next" looks at posts published in this window, and needs at least this many interactions. */
export const BEST_POST_DAYS = 14;
export const BEST_POST_MIN_INTERACTIONS = 5;
/** Most summaries sent per hourly tick — the rest are still due on the next one. */
export const MAX_PER_TICK = 200;

const DAY = 86_400_000;
const missing = (err: any) => ['42P01', '42703'].includes(err?.code ?? err?.cause?.code);
async function optional<T>(q: () => Promise<T>, fallback: T): Promise<T> {
    try { return await q(); } catch (err) { if (missing(err)) return fallback; throw err; }
}

// ── Settings and timing (pure) ────────────────────────────────────────────────────────────────────

/** Pure: the summary's settings from the Mentor's set-up answers. On unless switched off. */
export function morningSettings(ctx: unknown): { on: boolean; quiet: boolean } {
    const c = (ctx && typeof ctx === 'object') ? ctx as Record<string, unknown> : {};
    return { on: c.morningSummary !== 'off', quiet: c.quietMode === 'on' };
}

/** Pure: a time zone Intl accepts, or the default. */
export function safeTimeZone(tz: unknown): string {
    if (typeof tz !== 'string' || !tz.trim()) return DEFAULT_TIME_ZONE;
    try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return tz; } catch { return DEFAULT_TIME_ZONE; }
}

/** Pure: the workspace's local date and hour now. */
export function localNow(now: Date, timeZone: string): { date: string; hour: number } {
    const z = utcToZoned(now, timeZone);
    return { date: z.date, hour: Number(z.time.slice(0, 2)) };
}

/** Pure: is a summary due now? In the morning window, switched on, not in Quiet mode, not already done today. */
export function isMorningDue(settings: { on: boolean; quiet: boolean }, hour: number, alreadyToday: boolean): boolean {
    if (!settings.on || settings.quiet || alreadyToday) return false;
    return hour >= SEND_FROM_HOUR && hour <= SEND_UNTIL_HOUR;
}

/** Pure: the UTC instants bounding yesterday and today, in the workspace's time zone (clock changes included). */
export function dayWindows(today: string, timeZone: string): { yesterdayStart: Date; todayStart: Date; tomorrowStart: Date } {
    return {
        yesterdayStart: zonedToUtc(addDays(today, -1), '00:00', timeZone),
        todayStart: zonedToUtc(today, '00:00', timeZone),
        tomorrowStart: zonedToUtc(addDays(today, 1), '00:00', timeZone),
    };
}

// ── The inputs ────────────────────────────────────────────────────────────────────────────────────

export interface MorningInputs {
    /** Website sales yesterday, per currency, in minor units. */
    sales: Array<{ currency: string; count: number; total: number }>;
    /** Booking deposits paid yesterday, per currency... bookings carry no currency: the shop's, GBP by default. */
    deposits: { count: number; totalPence: number };
    /** Deals marked won yesterday; null when the Lead Generator isn't active. */
    won: { count: number; valueGbp: number } | null;
    bookingsToday: number;
    bookingRequests: number;
    enquiriesOpen: number;
    enquiriesYesterday: number;
    postsAwaitingReview: number;
    /** Actions held for a person's approval (pending_actions) — what the 09:00 digest email is about. */
    actionsAwaiting: number;
    openSuggestions: number;
    /** The best-performing post of the last 14 days, when its assistant is active. */
    bestPost: { assistantId: number; assistantName: string; platform: string; interactions: number; caption: string } | null;
}

export async function loadMorningInputs(db: Db, orgId: number, today: string, timeZone: string, now = new Date()): Promise<MorningInputs> {
    const { yesterdayStart, todayStart, tomorrowStart } = dayWindows(today, timeZone);

    const team: Array<{ id: number; name: string | null; roleKey: string | null; life: string | null; prov: string | null }> = await db.select({
        id: aiAssistants.id, name: aiAssistants.name, roleKey: masterAssistants.roleKey, life: aiAssistants.lifecycleStatus, prov: aiAssistants.provisioningStatus,
    }).from(aiAssistants).leftJoin(masterAssistants, eq(aiAssistants.masterAssistantId, masterAssistants.id))
        .where(eq(aiAssistants.organisationId, orgId));
    const active = team.filter((t) => teamState(t.life, t.prov) === 'active');
    const leadsActive = active.some((t) => t.roleKey === 'lead_qualifier');

    const sales: MorningInputs['sales'] = (await optional(() => db.select({
        currency: siteOrders.currency, count: sql<number>`count(*)::int`, total: sql<number>`coalesce(sum(${siteOrders.amountTotal}), 0)::int`,
    }).from(siteOrders).where(and(eq(siteOrders.organisationId, orgId), gte(siteOrders.createdAt, yesterdayStart), lt(siteOrders.createdAt, todayStart)))
        .groupBy(siteOrders.currency), [] as any[])).map((r: any) => ({ currency: String(r.currency || 'gbp'), count: Number(r.count), total: Number(r.total) }));

    // A deposit's booking is made when it is paid (the hold is released otherwise), so its created_at is the day.
    const [dep] = await optional(() => db.select({
        count: sql<number>`count(*)::int`, total: sql<number>`coalesce(sum(${bookings.depositPence}), 0)::int`,
    }).from(bookings).where(and(eq(bookings.organisationId, orgId), eq(bookings.paymentStatus, 'paid'),
        gte(bookings.createdAt, yesterdayStart), lt(bookings.createdAt, todayStart))), [] as any[]);

    let won: MorningInputs['won'] = null;
    if (leadsActive) {
        const [w] = await optional(() => db.select({
            count: sql<number>`count(*)::int`, value: sql<string>`coalesce(sum(${revenueEvents.valueGbp}), 0)::text`,
        }).from(revenueEvents).where(and(eq(revenueEvents.organisationId, orgId), eq(revenueEvents.outcome, 'won'),
            gte(revenueEvents.occurredAt, yesterdayStart), lt(revenueEvents.occurredAt, todayStart))), [] as any[]);
        won = { count: Number(w?.count ?? 0), valueGbp: Number(w?.value ?? 0) };
    }

    const [bk] = await optional(() => db.select({
        today: sql<number>`count(*) FILTER (WHERE ${bookings.status} = 'confirmed' AND ${bookings.startsAt} >= ${todayStart.toISOString()}::timestamptz AND ${bookings.startsAt} < ${tomorrowStart.toISOString()}::timestamptz)::int`,
        requests: sql<number>`count(*) FILTER (WHERE ${bookings.status} = 'pending' AND ${bookings.startsAt} >= ${now.toISOString()}::timestamptz)::int`,
    }).from(bookings).where(eq(bookings.organisationId, orgId)), [] as any[]);

    const [enq] = await optional(() => db.select({
        open: sql<number>`count(*) FILTER (WHERE ${siteEnquiries.status} = 'new')::int`,
        yesterday: sql<number>`count(*) FILTER (WHERE ${siteEnquiries.createdAt} >= ${yesterdayStart.toISOString()}::timestamptz AND ${siteEnquiries.createdAt} < ${todayStart.toISOString()}::timestamptz)::int`,
    }).from(siteEnquiries).where(eq(siteEnquiries.organisationId, orgId)), [] as any[]);

    const [posts] = await optional(() => db.select({ n: sql<number>`count(DISTINCT ${reviewCardKey})::int` })
        .from(scheduledPosts).where(and(eq(scheduledPosts.organisationId, orgId), awaitingReview())), [] as any[]);

    const [acts] = await optional(() => db.select({ n: sql<number>`count(*)::int` })
        .from(pendingActions).where(and(eq(pendingActions.organisationId, orgId), eq(pendingActions.status, 'pending'))), [] as any[]);

    const openSuggestions = (await loadOpenProposals(db, orgId).catch(() => [])).length;

    let bestPost: MorningInputs['bestPost'] = null;
    const activeIds = active.map((t) => t.id);
    if (activeIds.length) {
        const [best] = await optional(() => db.select({
            assistantId: postInsights.assistantId, platform: postInsights.platform, interactions: postInsights.totalInteractions, caption: scheduledPosts.caption,
        }).from(postInsights).innerJoin(scheduledPosts, eq(scheduledPosts.id, postInsights.scheduledPostId))
            .where(and(eq(postInsights.organisationId, orgId), isNotNull(postInsights.totalInteractions), inArray(postInsights.assistantId, activeIds),
                gte(postInsights.publishedAt, new Date(now.getTime() - BEST_POST_DAYS * DAY)), gte(postInsights.totalInteractions, BEST_POST_MIN_INTERACTIONS)))
            .orderBy(sql`${postInsights.totalInteractions} DESC`).limit(1), [] as any[]);
        if (best) {
            const who = active.find((t) => t.id === best.assistantId);
            bestPost = { assistantId: Number(best.assistantId), assistantName: who?.name || 'your Social Media Manager', platform: String(best.platform), interactions: Number(best.interactions), caption: String(best.caption ?? '') };
        }
    }

    return {
        sales, deposits: { count: Number(dep?.count ?? 0), totalPence: Number(dep?.total ?? 0) }, won,
        bookingsToday: Number(bk?.today ?? 0), bookingRequests: Number(bk?.requests ?? 0),
        enquiriesOpen: Number(enq?.open ?? 0), enquiriesYesterday: Number(enq?.yesterday ?? 0),
        postsAwaitingReview: Number(posts?.n ?? 0), actionsAwaiting: Number(acts?.n ?? 0), openSuggestions, bestPost,
    };
}

// ── The summary (pure) ────────────────────────────────────────────────────────────────────────────

export type MorningKey = 'money' | 'today' | 'enquiries' | 'needs_you' | 'next';
export interface MorningSummary {
    /** The local date it is for, and the date it describes ("yesterday"). */
    day: string;
    headline: string;
    sections: Array<{ key: MorningKey; title: string; lines: string[] }>;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Pure: minor units → "£85" / "£85.50" / "€12". */
export function money(minor: number, currency = 'gbp'): string {
    const value = minor / 100;
    try {
        return new Intl.NumberFormat('en-GB', { style: 'currency', currency: currency.toUpperCase(), minimumFractionDigits: Number.isInteger(value) ? 0 : 2 }).format(value);
    } catch {
        return `${value.toFixed(2)} ${currency.toUpperCase()}`;
    }
}

/** Pure: the first words of a caption, at a word. */
export function captionStart(caption: string, max = 60): string {
    const t = String(caption ?? '').replace(/\s+/g, ' ').trim();
    if (t.length <= max) return t;
    const cut = t.slice(0, max);
    return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 20))}…`;
}

const PLATFORM_NAMES: Record<string, string> = { instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn', x: 'X', tiktok: 'TikTok', youtube: 'YouTube' };

/** Pure: the summary. Every section is left out when it has nothing; no sections = nothing to send. */
export function buildMorningSummary(i: MorningInputs, day: string): MorningSummary {
    const sections: MorningSummary['sections'] = [];
    const head: string[] = [];

    const money_: string[] = [];
    for (const s of i.sales) if (s.count > 0) money_.push(`${plural(s.count, 'website sale')}, ${money(s.total, s.currency)}`);
    if (i.deposits.count > 0) money_.push(`${plural(i.deposits.count, 'booking deposit')} paid, ${money(i.deposits.totalPence)}`);
    if (i.won && i.won.count > 0) money_.push(`${plural(i.won.count, 'deal')} marked won${i.won.valueGbp > 0 ? `, ${money(Math.round(i.won.valueGbp * 100))}` : ''}`);
    if (money_.length) {
        sections.push({ key: 'money', title: 'Yesterday', lines: money_ });
        const sold = i.sales.reduce((n, s) => n + s.count, 0);
        if (sold) head.push(plural(sold, 'sale'));
        if (i.won?.count) head.push(`${plural(i.won.count, 'deal')} won`);
    }

    const today: string[] = [];
    if (i.bookingsToday > 0) today.push(`${plural(i.bookingsToday, 'booking')} today`);
    if (i.bookingRequests > 0) today.push(`${plural(i.bookingRequests, 'booking request')} waiting for your yes (Website ▸ Bookings)`);
    if (today.length) {
        sections.push({ key: 'today', title: 'Today', lines: today });
        if (i.bookingsToday) head.push(`${plural(i.bookingsToday, 'booking')} today`);
    }

    if (i.enquiriesOpen > 0) {
        const fresh = i.enquiriesYesterday > 0 ? ` (${i.enquiriesYesterday} new yesterday)` : '';
        sections.push({ key: 'enquiries', title: 'Enquiries', lines: [`${plural(i.enquiriesOpen, 'website enquiry', 'website enquiries')} to answer${fresh} (Website ▸ Enquiries)`] });
        head.push(plural(i.enquiriesOpen, 'enquiry', 'enquiries'));
    }

    const needs: string[] = [];
    if (i.postsAwaitingReview > 0) needs.push(`${plural(i.postsAwaitingReview, 'post')} to review (Review)`);
    if (i.actionsAwaiting > 0) needs.push(`${plural(i.actionsAwaiting, 'action')} waiting for your approval (Review)`);
    if (i.openSuggestions > 0) needs.push(`${plural(i.openSuggestions, 'suggestion')} from me (Notifications ▸ Needs you)`);
    if (needs.length) {
        sections.push({ key: 'needs_you', title: 'Waiting for you', lines: needs });
        if (!head.length) head.push(`${plural(i.postsAwaitingReview + i.actionsAwaiting + i.openSuggestions, 'thing')} waiting for you`);
    }

    if (i.bestPost) {
        const where = PLATFORM_NAMES[i.bestPost.platform] ?? i.bestPost.platform;
        const what = captionStart(i.bestPost.caption);
        sections.push({ key: 'next', title: 'Make next', lines: [
            `Your best post of the last two weeks${what ? `, “${what}”,` : ''} got ${plural(i.bestPost.interactions, 'interaction')} on ${where}. Ask ${i.bestPost.assistantName} for another like it.`,
        ] });
    }

    return { day, headline: head.join(' · ') || 'Your morning', sections };
}

/** Pure: the summary as one chat message (plain text, phone-readable). */
export function morningMessage(s: MorningSummary): string {
    const body = s.sections.map((x) => `${x.title}\n${x.lines.map((l) => `• ${l}`).join('\n')}`).join('\n\n');
    return `Your morning summary — ${formatDate(s.day)}\n\n${body}`;
}

/** Pure: one plain-text line per email slot; '' when the section is absent. */
export function morningEmailVars(s: MorningSummary): Record<string, string> {
    const line = (k: MorningKey) => {
        const x = s.sections.find((y) => y.key === k);
        return x ? `${x.title}: ${x.lines.join('; ')}` : '';
    };
    return { headline: s.headline, money: line('money'), today: line('today'), enquiries: line('enquiries'), needs_you: line('needs_you'), next: line('next') };
}

/** Pure: the Mentor's chat prompt line — its settings, and how to change them with the set-up card. */
export function renderMorningSettingsForMentor(mentorId: number, ctx: unknown): string {
    const st = morningSettings(ctx);
    const state = st.quiet ? 'off while Quiet mode is on' : st.on ? `on, at ${SEND_FROM_HOUR}am in the workspace's time zone` : 'switched off';
    return `YOUR MORNING SUMMARY: ${state}. Built from facts, never by you: yesterday's website sales, deposits and deals marked won; today's bookings and booking requests; open website enquiries; posts and your suggestions waiting; the best post of the last two weeks. Nothing is sent on a day with nothing to say, and it uses no tasks. It lands in the owners' and admins' chat with you; how each is told is "Business Mentor morning summary" in My Account ▸ Notifications (email is off unless they switch it on). It cannot see phone calls — never say it can. To switch it on or off when they ask, use setup_field_proposal with assistantId ${mentorId} and key "morningSummary" ("on" / "off"), "asked": true.`;
}

// ── Dispatch and delivery ─────────────────────────────────────────────────────────────────────────

export interface DispatchResult { considered: number; due: number; sent: number; empty: number; failed: number; ready: boolean }

export async function dispatchMornings(db: Db, now = new Date()): Promise<DispatchResult> {
    const out: DispatchResult = { considered: 0, due: 0, sent: 0, empty: 0, failed: 0, ready: true };
    let mentors: any[];
    try {
        await db.delete(mentorMornings).where(lt(mentorMornings.createdAt, new Date(now.getTime() - RETAIN_DAYS * DAY)));
        mentors = await db.select({
            id: aiAssistants.id, orgId: aiAssistants.organisationId, name: aiAssistants.name, ctx: aiAssistants.onboardingContext,
            tz: sql<string | null>`(SELECT bs.timezone FROM ${bookingSettings} bs WHERE bs.organisation_id = ${aiAssistants.organisationId} LIMIT 1)`,
        }).from(aiAssistants)
            .where(and(sql`${aiAssistants.configuration} ->> 'type' = ${MENTOR_ROLE_KEY}`, sql`coalesce(${aiAssistants.lifecycleStatus}, '') <> 'archived'`));
    } catch (err) {
        if (missing(err)) { out.ready = false; return out; }
        throw err;
    }
    for (const m of mentors) {
        out.considered++;
        const tz = safeTimeZone(m.tz);
        const { date, hour } = localNow(now, tz);
        if (!isMorningDue(morningSettings(m.ctx), hour, false)) continue;
        if (out.sent + out.empty >= MAX_PER_TICK) break;
        try {
            const [done] = await db.select({ id: mentorMornings.id }).from(mentorMornings)
                .where(and(eq(mentorMornings.organisationId, m.orgId), eq(mentorMornings.day, date))).limit(1);
            if (done) continue;
            out.due++;
            const usage = await getTaskUsage(db, m.orgId).catch(() => null);
            if (usage && !usage.hasPlan) continue;   // §2.7: no paid plan, no Mentor features beyond help
            // The latch: whoever inserts the day's row sends it; a second tick finds it and moves on.
            const [row] = await db.insert(mentorMornings).values({ organisationId: m.orgId, aiAssistantId: m.id, day: date, status: 'sent' })
                .onConflictDoNothing().returning({ id: mentorMornings.id });
            if (!row) continue;
            const result = await sendMorning(db, { rowId: row.id, orgId: m.orgId, mentorId: m.id, mentorName: m.name || 'Your Mentor', day: date, timeZone: tz, now });
            out[result]++;
        } catch (err) {
            out.failed++;
            console.error('[mentor-morning] failed for org', m.orgId, err instanceof Error ? err.message : err);
        }
    }
    return out;
}

/** Build and deliver one workspace's summary into its latched row. Never throws. */
async function sendMorning(db: Db, a: { rowId: number; orgId: number; mentorId: number; mentorName: string; day: string; timeZone: string; now: Date }): Promise<'sent' | 'empty' | 'failed'> {
    try {
        const inputs = await loadMorningInputs(db, a.orgId, a.day, a.timeZone, a.now);
        const summary = buildMorningSummary(inputs, a.day);
        if (!summary.sections.length) {
            await db.update(mentorMornings).set({ status: 'empty', summary }).where(eq(mentorMornings.id, a.rowId));
            return 'empty';
        }
        const people = await recipients(db, a.orgId);
        const [org] = await db.select({ name: organisations.name }).from(organisations).where(eq(organisations.id, a.orgId)).limit(1);
        const text = morningMessage(summary);
        const base = resolveBaseUrl() || process.env.BASE_URL || '';
        const emailed: number[] = [];
        for (const p of people) {
            const sid = await mentorChatFor(db, a.orgId, p.userId, a.mentorId);
            await db.insert(chatMessages).values({ chatSessionId: sid, role: 'assistant', content: text, uiElementJson: null });
            await db.update(chatSessions).set({ updatedAt: new Date() }).where(eq(chatSessions.id, sid));
            await createNotification(db, 'mentor_morning_summary', {
                userId: p.userId, assistantId: a.mentorId, category: 'state_change',
                context: { assistant: { name: a.mentorName }, morning: { headline: summary.headline } },
                metadata: { assistantId: a.mentorId, chatSessionId: sid, mentorMorningId: a.rowId },
            });
            if (isEmailEnabled(p.emailPrefs, 'mentor_morning_summary')) {
                const ok = await sendTemplatedEmail({
                    triggerKey: 'mentor_morning_summary', to: p.email,
                    vars: {
                        user: { first_name: p.firstName ?? '' }, assistant: { name: a.mentorName }, workspace: { name: org?.name ?? '' },
                        morning: morningEmailVars(summary),
                        link: { action_url: mentorReviewLink(base, a.mentorId, sid) },
                    },
                }).then((r: unknown) => r != null).catch((err: unknown) => { console.warn('[mentor-morning] email failed for user', p.userId, err instanceof Error ? err.message : err); return false; });
                if (ok) emailed.push(p.userId);
            }
        }
        await db.update(mentorMornings).set({ status: 'sent', summary, emailedUserIds: emailed }).where(eq(mentorMornings.id, a.rowId));
        return 'sent';
    } catch (err) {
        console.error('[mentor-morning] summary failed', { orgId: a.orgId, message: err instanceof Error ? err.message : String(err) });
        await recordPlatformIncident(db, { kind: 'mentor_morning', error: err, organisationId: a.orgId, assistantId: a.mentorId, role: 'business_mentor', ids: { mentorMorningId: a.rowId }, view: 'dispatch-mentor-mornings' }).catch(() => {});
        await db.update(mentorMornings).set({ status: 'failed' }).where(eq(mentorMornings.id, a.rowId)).catch(() => {});
        return 'failed';
    }
}

/** User ids emailed a morning summary since `since` — pending-actions-digest.ts skips them (D3). */
export async function emailedMorningUserIds(db: Db, since: Date): Promise<Set<number>> {
    const rows: any[] = await optional(() => db.select({ ids: mentorMornings.emailedUserIds }).from(mentorMornings)
        .where(and(eq(mentorMornings.status, 'sent'), gte(mentorMornings.createdAt, since))), []);
    return new Set(rows.flatMap((r) => (Array.isArray(r.ids) ? r.ids : []).map(Number)));
}

/**
 * The newest summary sent in the last two days, as the Mentor's chat reads it — so "how did yesterday
 * go?" in a NEW conversation is answered from the same facts. '' when there is none. Never throws.
 */
export async function latestMorningForMentor(db: Db, orgId: number, now = new Date()): Promise<string> {
    try {
        const [row] = await db.select({ summary: mentorMornings.summary }).from(mentorMornings)
            .where(and(eq(mentorMornings.organisationId, orgId), eq(mentorMornings.status, 'sent'), gte(mentorMornings.createdAt, new Date(now.getTime() - 2 * DAY))))
            .orderBy(sql`${mentorMornings.createdAt} DESC`).limit(1);
        const s = row?.summary as MorningSummary | undefined;
        if (!s?.sections?.length) return '';
        return `YOUR LATEST MORNING SUMMARY (facts as sent; quote them, don't recompute):\n${morningMessage(s)}`;
    } catch {
        return '';
    }
}
