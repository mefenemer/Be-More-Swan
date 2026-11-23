// src/utils/partner-weekly-nudge.ts
// The Monday summary from a partner's Partner Assistant (docs/partner-onboarding-plan.md §3.5, Phase 3).
// Last week's numbers (visits → sign-ups → in free trial → paying) and ONE suggested next step, which
// opens their Partner page with that question typed into the assistant.
//
// Owner decision D6 (2026-11-22): on by default, sent in their first 8 weeks and in any later week with
// activity; one click turns it off (Partner page, partner-hub `weekly_nudge`). Skipped when there is
// nothing to say. Built from data — no model call, so no surprise cost (plan §3.5).
//
// Pure: partner-weekly-nudge.ts (the scheduled function) loads the data, claims the week and sends.

import type { OnboardingStep, OnboardingStats } from './partner-onboarding';

export interface NudgeMarks { weekly_nudge_off_at?: string; nudge_started_at?: string; last_nudge_week?: string }
export interface WeekStats extends OnboardingStats {
    clicks_7d?: number; signups_7d?: number; paying_7d?: number; earned_7d_pence?: number;
}

export const NUDGE_WEEKS = 8;

/** ISO week, e.g. "2026-W48" — the idempotency key: one summary per partner per week. */
export function isoWeek(d: Date): string {
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
    return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function hadActivity(s: WeekStats): boolean {
    return Number(s.clicks_7d || 0) > 0 || Number(s.signups_7d || 0) > 0 || Number(s.paying_7d || 0) > 0 || Number(s.earned_7d_pence || 0) > 0;
}

export type SkipReason = 'not_approved' | 'no_account' | 'turned_off' | 'already_sent' | 'quiet_after_first_weeks';

/** Whether this partner gets a summary this week, and if not, why (logged by the sweep). */
export function nudgeDecision(input: { status: string; userId: number | null; marks: NudgeMarks; stats: WeekStats; now: Date }):
    { send: true } | { send: false; reason: SkipReason } {
    if (input.status !== 'approved') return { send: false, reason: 'not_approved' };
    if (!input.userId) return { send: false, reason: 'no_account' };
    if (input.marks.weekly_nudge_off_at) return { send: false, reason: 'turned_off' };
    if (input.marks.last_nudge_week === isoWeek(input.now)) return { send: false, reason: 'already_sent' };
    const started = input.marks.nudge_started_at ? new Date(input.marks.nudge_started_at) : null;
    const inFirstWeeks = !started || Number.isNaN(started.getTime()) || input.now.getTime() - started.getTime() < NUDGE_WEEKS * 7 * 86_400_000;
    if (!inFirstWeeks && !hadActivity(input.stats)) return { send: false, reason: 'quiet_after_first_weeks' };
    return { send: true };
}

/** The questions a summary may open the assistant with (?ask=<key>). Whitelisted: the page only fills these. */
export const ASK_PROMPTS: Record<string, string> = {
    terms: 'In plain English, what do the Partner Terms ask of me when I promote Be More Swan?',
    invite_page: 'Help me write the headline and a short line in my own words for my invite page.',
    first_post: 'Help me write my first post about how I use Be More Swan, in my own voice.',
    no_signups: 'People are visiting my link but nobody has signed up yet. What should I change?',
    trial: 'I have people in their free trial right now. What can I do to help them get going?',
    next: 'Looking at my numbers, what should I do next to get more paying customers?',
    plan: 'Give me a simple 30-day plan to launch my partnership.',
};

/** The ONE thing to do this week, from where they are. */
export function weeklyAction(steps: OnboardingStep[], stats: WeekStats): { key: keyof typeof ASK_PROMPTS; line: string } {
    const done = (k: string) => !!steps.find((s) => s.key === k)?.done;
    if (!done('terms')) return { key: 'terms', line: 'Accept the Partner Terms on your Partner page, so your assistant can start helping.' };
    if (Number(stats.in_trial || 0) > 0) return { key: 'trial', line: `${stats.in_trial} ${stats.in_trial === 1 ? 'person is' : 'people are'} in their free trial. If you know who, offer to help them get going — people helped early are far more likely to stay.` };
    if (!done('invite_page')) return { key: 'invite_page', line: 'Make your invite page yours — your photo and a line in your own words turn more visits into sign-ups.' };
    if (!done('first_draft') || !Number(stats.clicks_all || 0)) return { key: 'first_post', line: 'Write and share your first post about why you recommend Be More Swan — your assistant drafts it in your voice.' };
    if (!Number(stats.signups || 0)) return { key: 'no_signups', line: 'People are visiting but not signing up yet. Try a clearer, personal post about who it’s for.' };
    return { key: 'next', line: 'Keep going — ask your assistant what to do next from your numbers.' };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The summary's words — the same for the bell and the email. */
export function buildNudge(input: { firstName: string | null; stats: WeekStats; steps: OnboardingStep[] }) {
    const s = input.stats;
    const visits = Number(s.clicks_7d || 0), signups = Number(s.signups_7d || 0), trial = Number(s.in_trial || 0), paying = Number(s.paying_7d || 0);
    const earned = Number(s.earned_7d_pence || 0);
    const summary = `Last 7 days: ${plural(visits, 'visit', 'visits')}, ${plural(signups, 'sign-up', 'sign-ups')}, ${trial} in a free trial now, ${plural(paying, 'new paying customer', 'new paying customers')}`
        + (earned > 0 ? `, and £${(earned / 100).toFixed(2)} earned.` : '.');
    const action = weeklyAction(input.steps, s);
    const title = visits || signups || paying
        ? `Your week as a partner: ${plural(visits, 'visit', 'visits')}, ${plural(signups, 'sign-up', 'sign-ups')}`
        : 'Your week as a partner: one thing to try';
    return { title, summary, action, greeting: input.firstName ? `Hi ${input.firstName},` : 'Hi,' };
}
