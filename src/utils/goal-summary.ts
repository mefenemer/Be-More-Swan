// src/utils/goal-summary.ts
//
// How an assistant's goals collapse into ONE line on a card. Pure (no I/O) so the ranking is locked
// by tests rather than re-derived, slightly differently, at each of the three places that need it:
// the dashboard card, the My Assistants card (same component) and the assistant-detail header.
//
// Two questions, and they are deliberately answered separately:
//
//   1. WHICH goal is the headline?  → pickHeadlineGoal
//   2. What do the REST add up to?  → summariseGoals
//
// ── Why 'awaiting_update' and 'data_disconnected' are not performance states ──────────────
//
// The card previously bucketed every non-pending, non-on_track status into "Off Track"
// (get-assistants.ts). That was already wrong for `data_disconnected` — a lapsed Instagram token
// rendered as a failing goal — and user-reported metrics made it worse: a revenue goal merely
// waiting for this month's figure would have shown a red "1 Off Track" on the dashboard.
//
// Neither status says anything about performance. Both say the MEASUREMENT has stopped, and the last
// known progress is whatever it was. They are counted apart from on/at-risk/off-track, and the UI
// renders them muted, because they are a request for a small piece of admin — not a warning that the
// assistant is underperforming. They stay distinct from each other too, since the fixes differ:
// awaiting_update wants a number typed in; data_disconnected wants an integration re-authenticated.

import type { GoalStatus } from '../config/goal-metrics';

/** Statuses that mean "we've lost the reading", not "the goal is going badly". */
export const ATTENTION_STATUSES: readonly GoalStatus[] = ['awaiting_update', 'data_disconnected'];

/** Statuses that genuinely describe how the goal is tracking. */
export const PERFORMANCE_STATUSES: readonly GoalStatus[] = ['on_track', 'at_risk', 'off_track'];

export function isAttentionStatus(status: string): boolean {
    return (ATTENTION_STATUSES as readonly string[]).includes(status);
}

/** The minimum a goal row needs for ranking and counting. */
export interface SummarisableGoal {
    status: string;
    isPrimary?: boolean | null;
    createdAt?: Date | string | null;
}

export interface GoalSummary {
    total: number;
    // Performance — safe to render as coloured pills.
    onTrack: number;
    atRisk: number;
    offTrack: number;
    pending: number;
    // Measurement gaps — rendered muted, never as a performance verdict.
    awaitingUpdate: number;
    dataDisconnected: number;
    /** awaitingUpdate + dataDisconnected, for "is there anything to show in the quiet row at all". */
    needsAttention: number;
    /** True once at least one goal has a performance verdict — i.e. the pills say something real. */
    assessed: boolean;
}

export function summariseGoals(goals: readonly SummarisableGoal[]): GoalSummary {
    const s: GoalSummary = {
        total: goals.length,
        onTrack: 0, atRisk: 0, offTrack: 0, pending: 0,
        awaitingUpdate: 0, dataDisconnected: 0, needsAttention: 0,
        assessed: false,
    };
    for (const g of goals) {
        switch (g.status) {
            case 'on_track':          s.onTrack++; break;
            case 'at_risk':           s.atRisk++; break;
            case 'off_track':         s.offTrack++; break;
            case 'awaiting_update':   s.awaitingUpdate++; break;
            case 'data_disconnected': s.dataDisconnected++; break;
            // 'pending' and any unknown/legacy status: not a verdict, not a measurement gap.
            default:                  s.pending++; break;
        }
    }
    s.needsAttention = s.awaitingUpdate + s.dataDisconnected;
    s.assessed = s.onTrack + s.atRisk + s.offTrack > 0;
    return s;
}

/**
 * Rank for headline selection — LOWER wins. The headline answers "which single goal should this card
 * show", so it leads with the one that most needs looking at.
 *
 * The two attention states sit BELOW on_track deliberately. They are the quiet row's job; promoting
 * one to the headline over a goal that is genuinely tracking would contradict the whole point of
 * separating them. They still outrank `pending`, because they carry a real last-known figure and a
 * pending goal has nothing to draw.
 */
const HEADLINE_RANK: Record<string, number> = {
    off_track: 0,
    at_risk: 1,
    on_track: 2,
    awaiting_update: 3,
    data_disconnected: 4,
    pending: 5,
};

const rankOf = (status: string): number => HEADLINE_RANK[status] ?? HEADLINE_RANK.pending;
const timeOf = (d: Date | string | null | undefined): number => {
    if (!d) return 0;
    const t = d instanceof Date ? d.getTime() : Date.parse(d);
    return Number.isNaN(t) ? 0 : t;
};

/**
 * The one goal a card should show.
 *
 * An explicit PRIMARY always wins — the user said which goal this assistant is measured on, and a
 * card must not quietly disagree with them. Otherwise the most urgent, newest-first on a tie.
 *
 * The fallback is not a nicety. A user-reported metric can never be primary (manage-goals rejects
 * it), so an assistant whose goals are all revenue/subscriptions has NO primary at all, and the old
 * `find(isPrimary) || goals[0]` would have shown whichever happened to be newest.
 */
export function pickHeadlineGoal<T extends SummarisableGoal>(goals: readonly T[]): T | null {
    if (!goals.length) return null;
    const primary = goals.find(g => g.isPrimary);
    if (primary) return primary;
    return [...goals].sort((a, b) =>
        rankOf(a.status) - rankOf(b.status) || timeOf(b.createdAt) - timeOf(a.createdAt),
    )[0];
}
