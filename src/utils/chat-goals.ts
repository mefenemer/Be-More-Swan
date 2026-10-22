// src/utils/chat-goals.ts
// Every assistant chat's view of, and hands on, its own goals (the Results tab): the goals by "#id"
// with their figures, the metrics this assistant can set a goal on, and a card to set one, change one
// (target, date, name, main goal) or delete one.
//
// ── Why ──────────────────────────────────────────────────────────────────────────────────────────
// Every capability is meant to be reachable from the GUI and from chat, through the same server
// action. The chat could read its goals (chat-assistant-settings.ts, 2026-10-22) but was told they
// are "set or changed only" on the Results tab — "aim for 2,000 Instagram followers by March" ended
// in directions.
//
// ── How ──────────────────────────────────────────────────────────────────────────────────────────
// Same contract as chat-rules.ts. The model never acts. It proposes a `goal_proposal`; this module
// checks it with manage-goals.ts's OWN rules, so the card cannot offer what the click would refuse:
// the metric must be one this role may pick (availableMetricsForRole) and, if it needs a connection,
// connected (goal-connections.ts — the same function the endpoint uses); the target positive; the date
// in the future; the target attainable (assessGoalRealism, with the same known baseline); a figure the
// user reports themselves can never be the main goal. An existing goal must be this assistant's. The
// click (chat-session.js) calls manage-goals.ts — POST / PATCH / DELETE, as the Results tab does —
// which recompiles the brief so drafting steers toward the new target. Nothing here writes.
//
// ⚠️ Never throws.

import { and, desc, eq, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { goals } from '../../db/schema';
import { GOAL_METRICS, assessGoalRealism, availableMetricsForRole, getGoalMetric, isManualMetric, type GoalMetric } from '../config/goal-metrics';
import { connectedServices } from './goal-connections';

type Db = ReturnType<typeof getDb>;

export const GOAL_PROPOSAL_TYPE = 'goal_proposal';
export const GOAL_ACTIONS = ['create', 'update', 'delete'] as const;
export type GoalAction = typeof GOAL_ACTIONS[number];

/** manage-goals.ts's cap on a goal's name. */
const TITLE_MAX = 120;
const LIST_MAX = 10;

const GOAL_STATUS_WORDS: Record<string, string> = {
    pending: 'no figures yet', on_track: 'on track', at_risk: 'at risk', off_track: 'off track',
    data_disconnected: 'not being measured — its connection has stopped', awaiting_update: 'waiting for the user to enter this month’s figure',
};

const dayOf = (d: Date | string) => new Date(d).toISOString().slice(0, 10);
const num = (v: unknown) => Number(v);
const fmt = (n: number, m: GoalMetric | undefined) => `${Number.isInteger(n) ? n.toLocaleString('en-GB') : n}${m?.unit === '%' ? '%' : m?.unit ? ` ${m.unit}` : ''}`;
const ALL_SERVICES = [...new Set(GOAL_METRICS.map((m) => m.connectionService).filter((s): s is string => !!s))];

/** The role's metrics, split into ready now and needing a connection first. */
async function metricsFor(db: Db, organisationId: number, roleKey: string | null | undefined) {
    const services = await connectedServices(db, organisationId);
    const ready = availableMetricsForRole(roleKey, services);
    const needsConnection = availableMetricsForRole(roleKey, ALL_SERVICES).filter((m) => !ready.some((r) => r.key === m.key));
    return { services, ready, needsConnection };
}

// ── Read ─────────────────────────────────────────────────────────────────────────────────────────

/** Goals by id plus the metrics on offer, for this turn's prompt. Never throws. */
export async function buildGoalsBlock(db: Db, organisationId: number, aiAssistantId: number, roleKey: string | null | undefined): Promise<string> {
    try {
        const rows = await db.select({
            id: goals.id, title: goals.title, metricKey: goals.metricKey, targetValue: goals.targetValue, latestValue: goals.latestValue,
            targetDate: goals.targetDate, status: goals.status, isPrimary: goals.isPrimary,
        })
            .from(goals)
            .where(and(eq(goals.organisationId, organisationId), eq(goals.assistantId, aiAssistantId), eq(goals.isActive, true)))
            .orderBy(desc(goals.isPrimary), desc(goals.id))
            .limit(LIST_MAX);
        const { ready, needsConnection } = await metricsFor(db, organisationId, roleKey);
        const goalLines = rows.map((g) => {
            const m = getGoalMetric(g.metricKey);
            const name = g.title?.trim() || m?.label || g.metricKey;
            const now = g.latestValue != null ? `${fmt(num(g.latestValue), m)} now` : 'no figure yet';
            return `- #${g.id}${g.isPrimary ? ' (main goal)' : ''} ${name} [${g.metricKey}]: ${now}, target ${fmt(num(g.targetValue), m)} by ${dayOf(g.targetDate)} — ${GOAL_STATUS_WORDS[g.status] ?? g.status}.`;
        });
        const metricLine = (m: GoalMetric) => `"${m.key}" — ${m.label} (${m.unit || 'number'})${m.source === 'manual' ? ', a figure the user enters themselves (never a main goal)' : ''}`;
        return [
            'YOUR GOALS (Results tab), by "#" number, read this turn:',
            goalLines.length ? goalLines.join('\n') : '- none set yet',
            ready.length ? `Metrics you can set a goal on now:\n${ready.map((m) => `- ${metricLine(m)}`).join('\n')}` : 'There are no metrics you can set a goal on right now.',
            needsConnection.length
                ? `Metrics that need a connection first (the user connects it on the Connections card, then you can set the goal):\n${needsConnection.map((m) => `- ${metricLine(m)} — needs ${m.connectionService}`).join('\n')}`
                : '',
        ].filter(Boolean).join('\n');
    } catch (err) {
        console.error('[chat-goals] goals read failed (non-fatal)', err);
        return 'YOUR GOALS: could not be read this turn — if asked, say so; never guess a goal or a figure.';
    }
}

/** The prompt section that lets a structured route propose a goal change. */
export function goalsPromptBlock(): string {
    return `SETTING AND CHANGING YOUR GOALS — when the user asks to set a goal, change one's target, date or name, make one the main goal, or delete one, put this in "uiElement" instead of anything else (one change per reply):
{ "type": "goal_proposal", "action": "create", "metricKey": "<a key from the metrics above>", "targetValue": <number>, "targetDate": "YYYY-MM-DD", "title": "<short name, optional>" | null, "isPrimary": true | false }
{ "type": "goal_proposal", "action": "update", "goalId": <# number>, "targetValue": <number, or omit>, "targetDate": "YYYY-MM-DD" or omit, "title": "<new name>" or omit, "isPrimary": true or omit }
{ "type": "goal_proposal", "action": "delete", "goalId": <# number> }
A target is the number they want to REACH (followers in total, not followers gained), by a date in the future — turn their words ("by March", "in three months") into a date. Use only a metric listed above; if the one they want needs a connection, say which and do not propose it. If you can't tell the number or the date, ask. Before the card is shown it is checked like the Results tab checks it — a target too big for the time is refused there with a figure that would work, and you can offer that instead. You never change a goal yourself: the user confirms on the card, and only that click saves it. So never say a goal HAS been set, changed or deleted — say the card is there to confirm.`;
}

// ── Propose ──────────────────────────────────────────────────────────────────────────────────────

export interface GoalRequest {
    action: GoalAction;
    goalId: number | null;
    metricKey: string | null;
    targetValue: number | null;
    targetDate: string | null;
    title: string | null | undefined;
    isPrimary: boolean | undefined;
}

/** Shape check on the model's output. Pure. Null when it is not a usable proposal. */
export function goalProposalFromUiElement(uiElement: unknown): GoalRequest | null {
    if (!uiElement || typeof uiElement !== 'object') return null;
    const ui = uiElement as Record<string, unknown>;
    if (ui.type !== GOAL_PROPOSAL_TYPE) return null;
    const action = GOAL_ACTIONS.find((a) => a === ui.action);
    if (!action) return null;
    const target = ui.targetValue == null || ui.targetValue === '' ? null : Number(String(ui.targetValue).replace(/,/g, ''));
    const date = typeof ui.targetDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ui.targetDate.trim()) ? ui.targetDate.trim() : null;
    const title = ui.title === null ? null : typeof ui.title === 'string' && ui.title.trim() ? ui.title.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX) : undefined;
    const isPrimary = typeof ui.isPrimary === 'boolean' ? ui.isPrimary : undefined;
    const id = Number(String(ui.goalId ?? '').replace(/^#/, ''));
    if (target !== null && !Number.isFinite(target)) return null;
    if (action === 'create') {
        const metricKey = typeof ui.metricKey === 'string' ? ui.metricKey.trim() : '';
        if (!metricKey || target === null || !date) return null;
        return { action, goalId: null, metricKey, targetValue: target, targetDate: date, title, isPrimary };
    }
    if (!Number.isInteger(id) || id <= 0) return null;
    if (action === 'delete') return { action, goalId: id, metricKey: null, targetValue: null, targetDate: null, title: undefined, isPrimary: undefined };
    if (target === null && !date && title === undefined && isPrimary === undefined) return null;
    return { action, goalId: id, metricKey: null, targetValue: target, targetDate: date, title, isPrimary };
}

export interface GoalCard {
    type: typeof GOAL_PROPOSAL_TYPE;
    action: GoalAction;
    assistantId: number;
    goalId: number | null;
    metricKey: string | null;
    metricLabel: string | null;
    unit: string | null;
    /** The goal as it is now (update / delete), in words. */
    current: string | null;
    /** What the click saves, in words (create / update). */
    proposed: string | null;
    /** The exact values the click sends — only the fields that change, for update. */
    targetValue: number | null;
    targetDate: string | null;
    title: string | null | undefined;
    isPrimary: boolean | undefined;
    blocked: string | null;
    settled?: boolean;
}

interface GoalRow {
    id: number; assistantId: number; metricKey: string; title: string | null; targetValue: string; targetDate: Date;
    isPrimary: boolean; isActive: boolean; latestValue: string | null; startValue: string | null;
}

async function readGoal(db: Db, organisationId: number, goalId: number): Promise<GoalRow | null> {
    const [row] = await db.select({
        id: goals.id, assistantId: goals.assistantId, metricKey: goals.metricKey, title: goals.title, targetValue: goals.targetValue,
        targetDate: goals.targetDate, isPrimary: goals.isPrimary, isActive: goals.isActive, latestValue: goals.latestValue, startValue: goals.startValue,
    }).from(goals).where(and(eq(goals.id, goalId), eq(goals.organisationId, organisationId))).limit(1);
    return (row as GoalRow | undefined) ?? null;
}

function describe(m: GoalMetric | undefined, metricKey: string, title: string | null | undefined, target: number, date: string, primary: boolean): string {
    return `${title || m?.label || metricKey}: reach ${fmt(target, m)} by ${date}${primary ? ' — the main goal' : ''}`;
}

/** The known current value of a metric for this assistant — manage-goals.ts knownBaseline(), same rule. */
async function knownBaseline(db: Db, organisationId: number, aiAssistantId: number, metricKey: string): Promise<number | null> {
    const [row] = await db.select({ latestValue: goals.latestValue }).from(goals)
        .where(and(eq(goals.assistantId, aiAssistantId), eq(goals.organisationId, organisationId), eq(goals.metricKey, metricKey), sql`${goals.latestValue} IS NOT NULL`))
        .orderBy(desc(goals.updatedAt)).limit(1);
    const v = row?.latestValue;
    return v != null && Number.isFinite(Number(v)) ? Number(v) : null;
}

function realismBlock(metricKey: string, target: number, date: string, baseline: number | null, now: Date): string | null {
    const verdict = assessGoalRealism({ metricKey, targetValue: target, targetDate: date, baseline, now });
    if (verdict.ok) return null;
    return [verdict.reason, verdict.suggestion].filter(Boolean).join(' ') || 'That target isn’t reachable in the time.';
}

/** Check a proposal with manage-goals.ts's own rules and return the card. Null when the read fails. */
export async function resolveGoalProposal(
    db: Db, organisationId: number, aiAssistantId: number, roleKey: string | null | undefined, req: GoalRequest, now: Date = new Date(),
): Promise<GoalCard | null> {
    try {
        const card: GoalCard = {
            type: GOAL_PROPOSAL_TYPE, action: req.action, assistantId: aiAssistantId, goalId: req.goalId,
            metricKey: req.metricKey, metricLabel: null, unit: null, current: null, proposed: null,
            targetValue: req.targetValue, targetDate: req.targetDate, title: req.title, isPrimary: req.isPrimary, blocked: null,
        };
        const future = (d: string) => new Date(`${d}T23:59:59Z`).getTime() > now.getTime();

        if (req.action === 'create') {
            const m = getGoalMetric(req.metricKey!);
            card.metricLabel = m?.label ?? req.metricKey;
            card.unit = m?.unit ?? null;
            card.proposed = describe(m, req.metricKey!, req.title, req.targetValue!, req.targetDate!, req.isPrimary === true);
            const { ready, needsConnection } = await metricsFor(db, organisationId, roleKey);
            const waiting = needsConnection.find((x) => x.key === req.metricKey);
            if (!m || !m.available) card.blocked = 'That isn’t something a goal can be set on yet.';
            else if (waiting) card.blocked = `Connect ${waiting.connectionService} first (Connections card), then this goal can be set.`;
            else if (!ready.some((x) => x.key === req.metricKey)) card.blocked = `“${m.label}” isn’t a goal this assistant can have.`;
            else if (!(req.targetValue! > 0)) card.blocked = 'The target has to be a number above zero.';
            else if (!future(req.targetDate!)) card.blocked = 'The date has to be in the future.';
            else if (req.isPrimary && isManualMetric(req.metricKey!)) card.blocked = `“${m.label}” is a figure you report yourself, so it can’t be the main goal — it can be a supporting one.`;
            else card.blocked = realismBlock(req.metricKey!, req.targetValue!, req.targetDate!, await knownBaseline(db, organisationId, aiAssistantId, req.metricKey!), now);
            return card;
        }

        const row = await readGoal(db, organisationId, req.goalId!);
        if (!row || !row.isActive) { card.blocked = 'That goal no longer exists.'; return card; }
        if (row.assistantId !== aiAssistantId) { card.blocked = 'That goal belongs to a different assistant.'; return card; }
        const m = getGoalMetric(row.metricKey);
        card.metricKey = row.metricKey;
        card.metricLabel = m?.label ?? row.metricKey;
        card.unit = m?.unit ?? null;
        const curDate = dayOf(row.targetDate);
        card.current = describe(m, row.metricKey, row.title, num(row.targetValue), curDate, row.isPrimary);
        if (req.action === 'delete') return card;

        // Send only what changes, as the Results tab's edit form does.
        if (req.targetValue !== null && req.targetValue === num(row.targetValue)) card.targetValue = null;
        if (req.targetDate && req.targetDate === curDate) card.targetDate = null;
        if (req.title !== undefined && (req.title ?? null) === (row.title ?? null)) card.title = undefined;
        if (req.isPrimary !== undefined && req.isPrimary === row.isPrimary) card.isPrimary = undefined;
        const nextTarget = card.targetValue ?? num(row.targetValue);
        const nextDate = card.targetDate ?? curDate;
        const nextTitle = card.title !== undefined ? card.title : row.title;
        const nextPrimary = card.isPrimary ?? row.isPrimary;
        card.proposed = describe(m, row.metricKey, nextTitle, nextTarget, nextDate, nextPrimary);
        if (card.targetValue === null && card.targetDate === null && card.title === undefined && card.isPrimary === undefined) card.blocked = 'That goal already says exactly that.';
        else if (card.isPrimary === false) card.blocked = 'A goal stops being the main one when another is made the main goal — say which one should be.';
        else if (!(nextTarget > 0)) card.blocked = 'The target has to be a number above zero.';
        else if (card.targetDate && !future(card.targetDate)) card.blocked = 'The date has to be in the future.';
        else if (card.isPrimary && isManualMetric(row.metricKey)) card.blocked = `“${card.metricLabel}” is a figure you report yourself, so it can’t be the main goal.`;
        else if (card.targetValue !== null || card.targetDate !== null) {
            const baseline = row.latestValue ?? row.startValue;
            card.blocked = realismBlock(row.metricKey, nextTarget, nextDate, baseline != null ? num(baseline) : null, now);
        }
        return card;
    } catch (err) {
        console.error('[chat-goals] could not resolve the proposal (non-fatal)', err);
        return null;
    }
}

// ── Reopening a conversation ─────────────────────────────────────────────────────────────────────
// A create card is closed once an active goal on that metric with that target and date exists (the
// endpoint makes a new row on every POST, so a reload must not offer it twice). Update and delete
// cards are re-checked against the row.

export async function refreshGoalCards<M extends { uiElement: unknown }>(
    db: Db, organisationId: number, aiAssistantId: number, messages: M[],
): Promise<M[]> {
    return Promise.all(messages.map(async (m) => {
        const ui = m.uiElement as Record<string, unknown> | null;
        if (!ui || ui.type !== GOAL_PROPOSAL_TYPE || ui.settled) return m;
        const req = goalProposalFromUiElement(ui);
        if (!req) return m;
        try {
            if (req.action === 'create') {
                const rows = await db.select({ id: goals.id, targetValue: goals.targetValue, targetDate: goals.targetDate }).from(goals)
                    .where(and(eq(goals.organisationId, organisationId), eq(goals.assistantId, aiAssistantId), eq(goals.metricKey, req.metricKey!), eq(goals.isActive, true)))
                    .limit(LIST_MAX);
                const saved = rows.find((r) => num(r.targetValue) === req.targetValue && dayOf(r.targetDate) === req.targetDate);
                return saved ? { ...m, uiElement: { ...ui, goalId: saved.id, settled: true, blocked: `Saved — it’s goal #${saved.id} on the Results tab.` } } : m;
            }
            const row = await readGoal(db, organisationId, req.goalId!);
            if (req.action === 'delete') {
                return !row || !row.isActive ? { ...m, uiElement: { ...ui, settled: true, blocked: 'Deleted.' } } : m;
            }
            if (!row || !row.isActive) return { ...m, uiElement: { ...ui, settled: true, blocked: 'That goal no longer exists.' } };
            const done = (ui.targetValue == null || num(ui.targetValue) === num(row.targetValue))
                && (ui.targetDate == null || ui.targetDate === dayOf(row.targetDate))
                && (ui.title === undefined || (ui.title ?? null) === (row.title ?? null))
                && (ui.isPrimary == null || ui.isPrimary === row.isPrimary);
            return done ? { ...m, uiElement: { ...ui, settled: true, blocked: 'Already done — the goal says this now.' } } : m;
        } catch (err) {
            console.error('[chat-goals] could not refresh a stored card (non-fatal)', err);
            return m;
        }
    }));
}
