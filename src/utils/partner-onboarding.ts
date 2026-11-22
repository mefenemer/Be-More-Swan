// src/utils/partner-onboarding.ts
// Partner onboarding (docs/partner-onboarding-plan.md, Phase 1): the welcome a newly approved partner
// gets on their Partner page — the "Your first week" checklist, the greeting their Partner Assistant
// opens with, and the starter buttons that follow their progress.
//
// Everything here is PURE and built from real data (owner decision D2, 2026-11-22): the greeting is not
// a model call, so it is free, instant, doesn't use one of their messages, and its numbers are exact.
// Every tick comes from something that happened — never from a "mark as done" click.

import { commissionPence } from './partner-rate-periods';

export interface PartnerTermsNow { rateBps: number; costDeductionBps: number; durationMonths: number | null }
export interface OnboardingMarks { link_copied_at?: string; first_draft_at?: string; dismissed_at?: string; assistant_started_at?: string }
export interface OnboardingStats { clicks_all?: number; signups?: number; paying?: number }

export type StepKey = 'terms' | 'payout' | 'first_draft' | 'share' | 'first_visit' | 'first_signup' | 'first_paying';
export interface OnboardingStep { key: StepKey; label: string; done: boolean; automatic: boolean }

/** Steps 1–4 are hers to do; 5–7 tick themselves as people respond. The card folds once 1–4 are done. */
export const SETUP_STEPS: StepKey[] = ['terms', 'payout', 'first_draft', 'share'];

/** The marks the Partner page may record itself (partner-hub.ts `onboarding` action). */
export const PAGE_MARKS = ['link_copied', 'dismissed', 'reopened'] as const;
export type PageMark = typeof PAGE_MARKS[number];

const pct = (bps: number) => {
    const n = bps / 100;
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
};

/** One plain line: "50% of what each customer you invite pays, after a 20% cost deduction, for their first 12 months". */
export function rateLine(t: PartnerTermsNow | null): string {
    if (!t) return 'a share of what each customer you invite pays';
    const costs = t.costDeductionBps > 0 ? `, after a ${pct(t.costDeductionBps)}% cost deduction` : '';
    const length = t.durationMonths == null ? ', for as long as they stay a customer'
        : `, for their first ${t.durationMonths} month${t.durationMonths === 1 ? '' : 's'}`;
    return `${pct(t.rateBps)}% of what each customer you invite pays (excluding VAT)${costs}${length}`;
}

/** "every £29 a customer pays earns you £11.60" — from a real plan price, with the ledger's own sum. */
export function exampleLine(t: PartnerTermsNow | null, planPriceGbp: number | null): string | null {
    if (!t || !planPriceGbp || planPriceGbp <= 0) return null;
    const pricePence = Math.round(planPriceGbp * 100);
    const earn = commissionPence(pricePence, t.rateBps, t.costDeductionBps);
    if (earn <= 0) return null;
    const money = (p: number) => `£${(p / 100).toFixed(2).replace(/\.00$/, '')}`;
    return `every ${money(pricePence)} a customer pays (excluding VAT) earns you £${(earn / 100).toFixed(2)}`;
}

export function buildChecklist(input: {
    termsAccepted: boolean; payoutSet: boolean; marks: OnboardingMarks; stats: OnboardingStats | null;
}): OnboardingStep[] {
    const s = input.stats || {};
    return [
        { key: 'terms', label: 'Accept the Partner Terms', done: input.termsAccepted, automatic: false },
        { key: 'payout', label: 'Tell us where to pay you', done: input.payoutSet, automatic: false },
        { key: 'first_draft', label: 'Write your first post with your Partner Assistant', done: !!input.marks.first_draft_at, automatic: false },
        { key: 'share', label: 'Copy your link and send it personally to 5 people who’d benefit', done: !!input.marks.link_copied_at, automatic: false },
        { key: 'first_visit', label: 'Your first visit', done: Number(s.clicks_all || 0) > 0, automatic: true },
        { key: 'first_signup', label: 'Your first sign-up', done: Number(s.signups || 0) > 0, automatic: true },
        { key: 'first_paying', label: 'Your first paying customer', done: Number(s.paying || 0) > 0, automatic: true },
    ];
}

/** Folded when the setup steps are all done, or she folded it herself. */
export function checklistFolded(steps: OnboardingStep[], marks: OnboardingMarks): boolean {
    if (marks.dismissed_at) return true;
    return SETUP_STEPS.every((k) => steps.find((s) => s.key === k)?.done);
}

export interface Starter { label: string; prompt: string }

/** Starter buttons that follow where she is (plan §2.5). The first is the most useful next thing. */
export function startersFor(steps: OnboardingStep[], stats: OnboardingStats | null): Starter[] {
    const done = (k: StepKey) => !!steps.find((s) => s.key === k)?.done;
    const s = stats || {};
    // The assistant refuses every message until the current Terms are accepted (partner-assistant.ts 403), so
    // no starter is offered before then — the page shows "accept step 1 first" instead (review of #813).
    if (!done('terms')) return [];
    const out: Starter[] = [];
    if (!done('first_draft') || !Number(s.clicks_all || 0)) out.push({ label: 'Write my first post', prompt: 'Help me write my first post about how I use Be More Swan, in my own voice.' });
    else if (!Number(s.signups || 0)) out.push({ label: 'Why no sign-ups yet?', prompt: 'People are visiting my link but nobody has signed up yet. What should I change?' });
    else if (!Number(s.paying || 0)) out.push({ label: 'My sign-ups are in trial', prompt: 'I have sign-ups but nobody paying yet — they are probably in the free trial. What can I do now?' });
    else out.push({ label: 'What should I do next?', prompt: 'Looking at my numbers, what should I do next to get more paying customers?' });
    out.push({ label: 'Who should I tell first?', prompt: 'Who should I tell about Be More Swan first, and how do I pick my first 20 people?' });
    out.push({ label: 'Give me a 30-day plan', prompt: 'Give me a simple 30-day plan to launch my partnership.' });
    out.push({ label: 'Email to my list', prompt: 'Draft a short email to my newsletter subscribers recommending Be More Swan.' });
    out.push({ label: 'How do I get paid?', prompt: 'How much will I be paid, and when?' });
    return out.slice(0, 5);
}

/** The greeting her Partner Assistant opens with. No model call (D2). */
export function welcomeGreeting(input: {
    firstName: string | null; businessName: string | null; terms: PartnerTermsNow | null; planPriceGbp: number | null;
    steps: OnboardingStep[];
}): string {
    const hi = input.firstName ? `Hi ${input.firstName}, I’m your Partner Assistant.` : 'Hi, I’m your Partner Assistant.';
    const example = exampleLine(input.terms, input.planPriceGbp);
    const earn = `You earn ${rateLine(input.terms)}.${example ? ` So ${example}.` : ''}`;
    const todo: string[] = [];
    const done = (k: StepKey) => !!input.steps.find((s) => s.key === k)?.done;
    if (!done('terms')) todo.push('accept the Partner Terms (they include the rules for promoting us)');
    if (!done('payout')) todo.push('tell us where to pay you');
    if (!done('first_draft')) todo.push(input.businessName ? `write your first post about how ${input.businessName} uses Be More Swan` : 'write your first post about why you recommend Be More Swan');
    if (!done('share')) todo.push('send your link personally to 5 people who’d benefit');
    const plan = todo.length
        ? `Here’s your plan for this week:\n${todo.slice(0, 3).map((t, i) => `${i + 1}. ${t[0].toUpperCase()}${t.slice(1)}`).join('\n')}`
        : 'Your setup is done. Ask me for a 30-day plan, a post, an email to your list or a demo script — or what to do next from your numbers.';
    const close = done('terms')
        ? 'I write in your voice and always add your link and an ad label. Where would you like to start?'
        : 'Once you’ve accepted the Partner Terms (step 1 on your first-week list), I’m ready to help — I write in your voice and always add your link and an ad label.';
    return `${hi} ${earn}\n\n${plan}\n\n${close}`;
}

/**
 * D7: 100 messages in the first 30 days, then 50 in any 30 days. The month starts at their FIRST
 * message (onboarding.assistant_started_at, written once) — not partners.decided_at, which every
 * suspend / reinstate / re-approve resets and would hand out another 100 (review of #813).
 */
export const ASSISTANT_LIMIT_FIRST_MONTH = 100;
export const ASSISTANT_LIMIT_AFTER = 50;
export function partnerAssistantLimit(startedAt: Date | null, now = new Date()): number {
    if (!startedAt || Number.isNaN(startedAt.getTime())) return ASSISTANT_LIMIT_FIRST_MONTH;   // this is their first message
    return now.getTime() - startedAt.getTime() < 30 * 86_400_000 ? ASSISTANT_LIMIT_FIRST_MONTH : ASSISTANT_LIMIT_AFTER;
}
