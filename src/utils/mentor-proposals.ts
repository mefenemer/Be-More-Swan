// src/utils/mentor-proposals.ts
// How every Business Mentor suggestion behaves (docs/business-mentor-plan.md §3.13), over the
// mentor_proposals table (db/z-business-mentor.sql):
//
//   - At most WEEKLY_CAP suggestions a week per workspace (Monday to Sunday, UK time). A card the user
//     asked for directly ("asked") is never refused and never counted: answering a question isn't a
//     suggestion.
//   - Dismiss with a reason. "Not now" snoozes that kind of suggestion for SNOOZE_DAYS; "Disagree" and
//     "Not relevant" stop it until the user brings it back; "Already done" stops nothing (the gap has
//     closed, so the Mentor won't raise it).
//   - Dismissed suggestions are listed on the Mentor's Overview tab with "Bring back".
//
// One module for the chat route (gate before a card is drawn, and the prompt's summary), the card's
// Dismiss button and the Overview tab — both reach it through netlify/functions/mentor.ts.

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { mentorProposals } from '../../db/schema';

type Db = any;

export const WEEKLY_CAP = 3;
export const SNOOZE_DAYS = 14;

export const DISMISS_REASONS = {
    not_relevant: 'Not relevant',
    already_done: 'Already done',
    disagree: 'Disagree',
    not_now: 'Not now',
} as const;
export type DismissReason = keyof typeof DISMISS_REASONS;

export const isDismissReason = (v: unknown): v is DismissReason => typeof v === 'string' && Object.prototype.hasOwnProperty.call(DISMISS_REASONS, v);

export interface DismissedRow {
    id: number;
    kind: string;
    title: string;
    why: string | null;
    fields: string[];
    reason: DismissReason;
    snoozedUntil: Date | null;
    decidedAt: Date | null;
}

export interface ProposalState {
    /** Suggestions (not direct asks) shown since Monday. */
    usedThisWeek: number;
    dismissed: DismissedRow[];
}

/** The Business Information fields a card fills; [] for kinds that have none (products). */
export function proposalFields(payload: unknown): string[] {
    const f = (payload && typeof payload === 'object') ? (payload as { fields?: unknown }).fields : null;
    return f && typeof f === 'object' ? Object.keys(f as object).sort() : [];
}

/**
 * Pure: the dismissal that still holds a new suggestion back, or null. Same kind, and (where both name
 * fields) at least one field in common — dismissing "add your website" mustn't silence "add your
 * description".
 */
export function holdingDismissal(kind: string, fields: string[], dismissed: DismissedRow[], now: Date): DismissedRow | null {
    return dismissed.find((d) => {
        if (d.kind !== kind) return false;
        const holds = d.reason === 'disagree' || d.reason === 'not_relevant'
            || (d.reason === 'not_now' && !!d.snoozedUntil && d.snoozedUntil.getTime() > now.getTime());
        if (!holds) return false;
        return !fields.length || !d.fields.length || fields.some((f) => d.fields.includes(f));
    }) ?? null;
}

export type GateResult = { ok: true } | { ok: false; why: 'cap' | 'dismissed'; note: string };

/** Pure: may this suggestion be drawn? A direct ask always may. */
export function gateSuggestion(input: { kind: string; fields: string[]; asked: boolean }, state: ProposalState, now: Date): GateResult {
    if (input.asked) return { ok: true };
    const held = holdingDismissal(input.kind, input.fields, state.dismissed, now);
    if (held) {
        return { ok: false, why: 'dismissed', note: held.reason === 'not_now' && held.snoozedUntil
            ? `I've left out a suggestion card: you said "not now" to that until ${ukDate(held.snoozedUntil)}. Ask me for it and I'll draw it.`
            : 'I\'ve left out a suggestion card: you dismissed that kind of suggestion. Bring it back from "Dismissed suggestions" on my Overview tab, or ask me for it directly.' };
    }
    if (state.usedThisWeek >= WEEKLY_CAP) {
        return { ok: false, why: 'cap', note: `I've left out a suggestion card: that's my ${WEEKLY_CAP} suggestions for this week. Ask me for it directly and I'll draw it.` };
    }
    return { ok: true };
}

const ukDate = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Europe/London' });

// Monday 00:00 in the UK, as an instant.
const WEEK_START = sql`(date_trunc('week', now() AT TIME ZONE 'Europe/London') AT TIME ZONE 'Europe/London')`;
const NOT_ASKED = sql`coalesce(${mentorProposals.payload} ->> 'asked', 'false') <> 'true'`;

const missingTable = (err: any) => ['42P01', '42703'].includes(err?.code ?? err?.cause?.code);

/** This week's count and every dismissed suggestion. Never throws: on a read error, nothing is held back. */
export async function loadProposalState(db: Db, orgId: number): Promise<ProposalState | null> {
    try {
        const [[week], rows] = await Promise.all([
            db.select({ n: sql<number>`count(*)::int` }).from(mentorProposals)
                .where(and(eq(mentorProposals.organisationId, orgId), sql`${mentorProposals.shownAt} >= ${WEEK_START}`, NOT_ASKED)),
            db.select({
                id: mentorProposals.id, kind: mentorProposals.kind, title: mentorProposals.title, evidence: mentorProposals.evidence,
                payload: mentorProposals.payload, reason: mentorProposals.dismissReason, snoozedUntil: mentorProposals.snoozedUntil,
                decidedAt: mentorProposals.decidedAt,
            }).from(mentorProposals)
                .where(and(eq(mentorProposals.organisationId, orgId), eq(mentorProposals.status, 'dismissed')))
                .orderBy(desc(mentorProposals.decidedAt)).limit(50),
        ]);
        return {
            usedThisWeek: Number(week?.n ?? 0),
            dismissed: rows.filter((r: any) => isDismissReason(r.reason)).map((r: any) => ({
                id: r.id, kind: r.kind, title: r.title, fields: proposalFields(r.payload),
                why: Array.isArray(r.evidence) && r.evidence[0]?.text ? String(r.evidence[0].text) : null,
                reason: r.reason, snoozedUntil: r.snoozedUntil ? new Date(r.snoozedUntil) : null,
                decidedAt: r.decidedAt ? new Date(r.decidedAt) : null,
            })),
        };
    } catch (err) {
        if (!missingTable(err)) console.warn('[mentor-proposals] could not read proposals (non-blocking):', (err as Error)?.message);
        return null;
    }
}

/** Pure: the prompt's summary of this week's suggestions and what not to raise again. */
export function renderProposalState(state: ProposalState | null, now = new Date()): string {
    if (!state) return 'SUGGESTIONS THIS WEEK: unknown right now — offer at most one suggestion card in this reply.';
    const left = Math.max(0, WEEKLY_CAP - state.usedThisWeek);
    const lines = [left
        ? `SUGGESTIONS THIS WEEK: ${state.usedThisWeek} of ${WEEKLY_CAP} used. Pick only the ones with the most evidence and impact.`
        : `SUGGESTIONS THIS WEEK: all ${WEEKLY_CAP} used. Draw no suggestion card you weren't asked for until Monday; you may still mention a gap in words.`];
    const holding = state.dismissed.filter((d) => holdingDismissal(d.kind, d.fields, [d], now));
    if (holding.length) {
        lines.push('DISMISSED BY THE USER — never suggest these again unless they ask:');
        lines.push(...holding.slice(0, 10).map((d) => `- ${d.title} (${DISMISS_REASONS[d.reason].toLowerCase()}${d.reason === 'not_now' && d.snoozedUntil ? `, until ${ukDate(d.snoozedUntil)}` : ''})`));
    }
    return lines.join('\n');
}

/** Gate a suggestion before it is drawn. On a read error it is allowed (the card is the user's choice anyway). */
export async function gateMentorSuggestion(db: Db, orgId: number, input: { kind: string; fields: string[]; asked: boolean }): Promise<GateResult> {
    const state = await loadProposalState(db, orgId);
    return state ? gateSuggestion(input, state, new Date()) : { ok: true };
}

/**
 * The user's answer to a suggestion: accepted (after the click saved), or dismissed with a reason.
 * Only a suggestion still open (or, for accepted, one they dismissed and changed their mind on) moves.
 * Returns false when there is no such suggestion in this workspace.
 */
export async function decideProposal(
    db: Db, orgId: number, userId: number, id: number, decision: 'accepted' | 'dismissed', reason?: DismissReason,
): Promise<boolean> {
    if (decision === 'dismissed' && !reason) return false;
    const rows = await db.update(mentorProposals).set(decision === 'accepted'
        ? { status: 'accepted', dismissReason: null, snoozedUntil: null, decidedAt: new Date(), decidedBy: userId }
        : {
            status: 'dismissed', dismissReason: reason, decidedAt: new Date(), decidedBy: userId,
            snoozedUntil: reason === 'not_now' ? new Date(Date.now() + SNOOZE_DAYS * 86_400_000) : null,
        })
        .where(and(
            eq(mentorProposals.id, id), eq(mentorProposals.organisationId, orgId),
            inArray(mentorProposals.status, decision === 'accepted' ? ['shown', 'dismissed'] : ['shown']),
        ))
        .returning({ id: mentorProposals.id });
    return rows.length > 0;
}

/** "Bring back": the dismissal stops holding that kind of suggestion back. */
export async function bringBackProposal(db: Db, orgId: number, id: number): Promise<boolean> {
    const rows = await db.update(mentorProposals)
        .set({ status: 'shown', dismissReason: null, snoozedUntil: null, decidedAt: null, decidedBy: null })
        .where(and(eq(mentorProposals.id, id), eq(mentorProposals.organisationId, orgId), eq(mentorProposals.status, 'dismissed')))
        .returning({ id: mentorProposals.id });
    return rows.length > 0;
}

/** The kinds "Review all" can apply: each has a card with a click that writes (mentor-apply.js applyCard). */
export const REVIEWABLE_KINDS = ['business_info_gap', 'products_gap', 'setup_field'] as const;
/** A suggestion older than this is left out of "Review all": the workspace has likely moved on. */
export const OPEN_MAX_AGE_DAYS = 30;

export interface OpenProposal { id: number; kind: string; title: string; why: string | null; card: unknown; shownAt: Date | null }

/** Pure: the newest of each kind + fields — the same gap suggested in two chats is one row to review. */
export function dedupeOpen(rows: OpenProposal[]): OpenProposal[] {
    const seen = new Set<string>();
    return rows.filter((r) => {
        const sig = `${r.kind}|${proposalFields(r.card).join(',')}|${r.kind === 'products_gap' ? JSON.stringify((r.card as any)?.products?.map((p: any) => p?.name) ?? []) : ''}`;
        if (seen.has(sig)) return false;
        seen.add(sig);
        return true;
    });
}

/** Suggestions still waiting for an answer ("Review all", §3.13), newest first. Never throws. */
export async function loadOpenProposals(db: Db, orgId: number): Promise<OpenProposal[]> {
    try {
        const rows = await db.select({
            id: mentorProposals.id, kind: mentorProposals.kind, title: mentorProposals.title, evidence: mentorProposals.evidence,
            payload: mentorProposals.payload, shownAt: mentorProposals.shownAt,
        }).from(mentorProposals)
            .where(and(
                eq(mentorProposals.organisationId, orgId), eq(mentorProposals.status, 'shown'),
                inArray(mentorProposals.kind, [...REVIEWABLE_KINDS]),
                sql`${mentorProposals.shownAt} >= now() - make_interval(days => ${OPEN_MAX_AGE_DAYS})`,
            ))
            .orderBy(desc(mentorProposals.shownAt)).limit(40);
        return dedupeOpen(rows.map((r: any) => ({
            id: r.id, kind: r.kind, title: r.title,
            why: Array.isArray(r.evidence) && r.evidence[0]?.text ? String(r.evidence[0].text) : null,
            card: r.payload ?? null, shownAt: r.shownAt ? new Date(r.shownAt) : null,
        }))).slice(0, 20);
    } catch (err) {
        if (!missingTable(err)) console.warn('[mentor-proposals] could not read open suggestions (non-blocking):', (err as Error)?.message);
        return [];
    }
}
