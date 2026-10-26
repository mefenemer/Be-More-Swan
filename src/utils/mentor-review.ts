// src/utils/mentor-review.ts
// The Business Mentor's weekly review (docs/business-mentor-plan.md §5, §2.1, §2.4, §2.5, §3.11–3.13),
// over the mentor_reviews table (db/z-business-mentor-phase-3.sql).
//
// WHEN: once a week per workspace, on the Mentor's review day (its set-up answers `weeklyReview` and
// `reviewDay`, Monday by default) — dispatchDueReviews, called daily by dispatch-mentor-reviews.ts
// (production) and run-mentor-review-dispatch.ts (staging, from .github/workflows/staging-crons.yml).
// A missed day is caught up later the same week. Skipped: Quiet mode, the review switched off, no paid
// plan (§2.7), or the task allowance used up (§2.1). "Review my week now" (queueReviewNow — the Overview
// tab's button and the chat card, through mentor.ts) runs one on demand for an owner or admin.
//
// WHAT IT READS: Results across ACTIVE assistants only (roi-activity.ts, this week against last), goals,
// the approved strategy documents and last week's commitments (the workspace snapshot), its track record
// (mentor-outcomes.ts, re-measured first) and the business's customers (mentor-customers.ts).
//
// HONEST WHEN THIN: each figure has a minimum sample (MIN_WORK, mentor-outcomes MIN_SAMPLE, customers
// MIN_DEALS). With nothing that reaches it, no model is called and nothing is charged: the review says
// "not enough data yet", names what is missing, and asks one coaching question instead (§3.12).
//
// WHAT IT WRITES: a review message in each owner's and admin's chat with the Mentor (§2.5), followed by
// at most 3 proposals as the EXISTING cards (setup_field_proposal, Business Information, Products &
// Services, who to hire, a plan revision, a post request), each checked and rebuilt exactly as in chat,
// each naming the assistant it changes, gated by the 3-a-week cap and dismissals (mentor-proposals.ts).
// Recorded once in mentor_proposals, so the same card is in every recipient's chat AND in Inbox "Needs
// you"; answering it in one place shows it answered in the other (chat-card-refresh.ts). Each recipient
// is told by their own notification settings (`mentor_weekly_review`, in-app and email). Nothing is ever
// applied without a click. 1 task when a review is written by the model (work-metering.ts `mentor_review`).

import Anthropic from '@anthropic-ai/sdk';
import { and, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import { aiAssistants, chatMessages, chatSessions, mentorReviews, organisations, userOrganisations, userProfiles, users } from '../../db/schema';
import { adaptForModel, replyText } from '../config/model-options';
import { MENTOR_HONESTY_RULES, MENTOR_REVIEW_CRAFT } from '../constants/mentor-craft';
import { recordPlatformIncident } from './platform-incident';
import { contentFindings, contentFindingsText, loadContentChecks, renderContentChecksForMentor, type ContentCheckInputs } from './mentor-content-checks';
import { loadRoleModel, withRoleModel } from './assistant-model';
import { MENTOR_ROLE_KEY } from './mentor-provision';
import { renderMentorSnapshot, loadMentorSnapshotData, type MentorSnapshotData } from './mentor-snapshot';
import { gateSuggestion, loadOpenProposals, loadProposalState, proposalFields, renderProposalState, WEEKLY_CAP, type ProposalState } from './mentor-proposals';
import { mentorCardFromUiElement, onlyGapFields, proposalKind, recordMentorProposal } from './mentor-cards';
import { mentorSetupFieldPromptLine, resolveSetupFieldProposal, setupFieldRequestFromUiElement } from './chat-setup-field';
import { draftRequestPromptLine, resolveDraftRequest } from './mentor-draft-request';
import { buildStrategyCard } from './mentor-plan-cards';
import { loadStrategyDocs } from './strategy-documents';
import { recommendHires } from './mentor-hire';
import { cleanCommitmentTexts, loadCommitments, renderCommitmentsForMentor, weekStartUk, weeksBefore, type Commitment } from './mentor-commitments';
import { checkOutcomes, loadTrackRecord, renderTrackRecordForMentor, type TrackRecordItem } from './mentor-outcomes';
import { loadCustomers, nothingToSee, renderCustomersForMentor, type CustomersView } from './mentor-customers';
import { countRoiActivityByAssistant } from './roi-activity';
import { getTaskUsage, recordCompletedWork, TASK_LIMIT_MESSAGE } from './work-metering';
import { createNotification } from './notify';
import { isEmailEnabled } from './notification-prefs';
import { sendTemplatedEmail } from './email';
import { logAiUsage } from './ai-usage';
import { parseModelJson } from './model-json';
import { sanitizeForModel } from './text-safe';
import { shortQuestion } from './mentor-jobs';
import { isGlobalAiDisabled } from './platform-config';
import { resolveBaseUrl } from './base-url';

type Db = any;

const DAY = 86_400_000;
/** The code default for the review (§2.4, §3.11) — the same as the Mentor's other background jobs. */
export const REVIEW_DEFAULT_MODEL = 'claude-opus-5-5';
/** A week's work below this (this week + last, per assistant) isn't a trend. */
export const MIN_WORK = 5;
/** A review still running after this never reached or never finished its worker: it is ended, free. */
export const STALE_AFTER_MS = 20 * 60_000;
/** Most reviews queued per daily tick — the rest stay due for the next one. */
export const MAX_PER_TICK = 50;
/** Who receives the review (§2.5), as weekly-digest.ts does. */
export const REVIEW_ROLES = ['owner', 'admin'];

export const REVIEW_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
export type ReviewDay = typeof REVIEW_DAYS[number];

export const NOT_READY = 'Weekly reviews aren’t switched on for this workspace yet — please try again later.';
const missing = (err: any) => ['42P01', '42703'].includes(err?.code ?? err?.cause?.code);

/** Pure: the Mentor's review settings from its set-up answers. */
export function reviewSettings(ctx: unknown): { on: boolean; quiet: boolean; day: ReviewDay } {
    const c = (ctx && typeof ctx === 'object') ? ctx as Record<string, unknown> : {};
    // Stored as the option value ('Monday', as the email send day is); matched without case.
    const raw = String(c.reviewDay ?? '').toLowerCase();
    const day = (REVIEW_DAYS as readonly string[]).includes(raw) ? raw as ReviewDay : 'monday';
    return { on: c.weeklyReview !== 'off', quiet: c.quietMode === 'on', day };
}

/** Pure: 0 = Monday … 6 = Sunday, in UK time. */
export function ukWeekdayIndex(at: Date): number {
    const date = at.toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
    return (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
}

/**
 * Pure: is a scheduled review due? On the review day or later in the same week (a missed tick is caught
 * up), never twice in one week, never in Quiet mode or with the review switched off.
 */
export function isReviewDue(settings: { on: boolean; quiet: boolean; day: ReviewDay }, lastScheduledWeek: string | null, now: Date): boolean {
    if (!settings.on || settings.quiet) return false;
    if (lastScheduledWeek === weekStartUk(now)) return false;
    return ukWeekdayIndex(now) >= REVIEW_DAYS.indexOf(settings.day);
}

// ── Reading the week ─────────────────────────────────────────────────────────────────────────────

export interface AssistantFigures { id: number; name: string; role: string; thisWeek: number; lastWeek: number; enough: boolean; breakdown: string }
export interface ReviewInputs {
    data: MentorSnapshotData;
    proposals: ProposalState | null;
    figures: AssistantFigures[];
    commitments: Commitment[] | null;
    record: TrackRecordItem[] | null;
    customers: CustomersView | null;
    /** §6.1 content checks; null when they couldn't be read. Optional so older callers and tests still fit. */
    content?: ContentCheckInputs | null;
}

/** Pure: is there anything that reaches its minimum sample? Otherwise the review says "not enough data yet". */
export function hasEnoughData(i: Pick<ReviewInputs, 'data' | 'figures' | 'commitments' | 'record' | 'customers'>, now = new Date()): boolean {
    if (i.figures.some((f) => f.enough)) return true;
    if (i.data.goals.some((g) => g.latest !== null)) return true;
    if (i.customers?.deals?.enough || (i.customers?.reviews?.count ?? 0) >= 3 || (i.customers?.quiet?.length ?? 0) > 0) return true;
    const last = weeksBefore(weekStartUk(now), 1);
    if ((i.commitments ?? []).some((c) => c.weekStart === last)) return true;
    if ((i.record ?? []).some((r) => r.verdict === 'up' || r.verdict === 'down' || r.verdict === 'same')) return true;
    return false;
}

/** Pure: the figures block. "not enough data" is written beside every figure below its sample. */
export function renderFigures(figures: AssistantFigures[], data: MentorSnapshotData): string[] {
    const lines = ['THIS WEEK\'S FIGURES (active assistants only; work = items each produced, as on their Results tab):'];
    if (!figures.length) lines.push('- No active assistant: there are no assistant results to review. Review Business Information, their plans and commitments instead.');
    for (const f of figures) {
        lines.push(`- ${f.name} (${f.role}, assistantId ${f.id}): ${f.thisWeek} this week, ${f.lastWeek} the week before${f.breakdown ? ` (${f.breakdown})` : ''}${f.enough ? '' : ' — not enough data to call a trend'}`);
    }
    const goals = data.goals.filter((g) => g.latest !== null);
    if (goals.length) lines.push(`Goals with a measured value: ${goals.map((g) => `${g.assistant}: ${g.label} ${g.latest}/${g.target} by ${g.targetDate.toISOString().slice(0, 10)} (${g.status.replace(/_/g, ' ')})`).join('; ')}.`);
    return lines;
}

export async function readReviewInputs(db: Db, orgId: number, userId: number, now = new Date()): Promise<ReviewInputs> {
    await checkOutcomes(db, orgId, now);
    const [data, proposals, commitments, record, customers] = await Promise.all([
        loadMentorSnapshotData(db, orgId, userId),
        loadProposalState(db, orgId),
        loadCommitments(db, orgId, userId, now).catch(() => null),
        loadTrackRecord(db, orgId, now).catch(() => null),
        loadCustomers(db, orgId, now).catch((err: unknown) => { console.error('[mentor-review] customers unreadable (non-fatal)', err instanceof Error ? err.message : err); return null; }),
    ]);
    const active = data.team.filter((t) => t.state === 'active');
    const ids = active.map((t) => t.id);
    const [week, fortnight] = await Promise.all([
        countRoiActivityByAssistant(db, { organisationId: orgId, assistantIds: ids, windowStart: new Date(now.getTime() - 7 * DAY) }),
        countRoiActivityByAssistant(db, { organisationId: orgId, assistantIds: ids, windowStart: new Date(now.getTime() - 14 * DAY) }),
    ]);
    const figures = active.map((t) => {
        const w = week.get(t.id); const f = fortnight.get(t.id);
        const thisWeek = w?.completedTasks ?? 0;
        const lastWeek = Math.max(0, (f?.completedTasks ?? 0) - thisWeek);
        return {
            id: t.id, name: t.name, role: t.role, thisWeek, lastWeek, enough: thisWeek + lastWeek >= MIN_WORK && !w?.degraded && !f?.degraded,
            breakdown: (w?.breakdown ?? []).slice(0, 3).map((b) => `${b.count} ${b.label.toLowerCase()}`).join(', '),
        };
    });
    const content = await loadContentChecks(db, orgId, data);
    return { data, proposals, figures, commitments, record, customers, content };
}

/** Pure: the "not enough data yet" review, written in code (no model call, nothing charged). */
export function notEnoughDataReview(i: Pick<ReviewInputs, 'data' | 'figures' | 'commitments' | 'customers' | 'content'>, now = new Date()): { summary: string; sections: Array<{ title: string; text: string }> } {
    const thin: string[] = [];
    if (!i.figures.length) thin.push('no assistant is active yet, so there are no results to compare');
    else thin.push(`your assistants produced ${i.figures.reduce((s, f) => s + f.thisWeek + f.lastWeek, 0)} items in two weeks — under ${MIN_WORK} each is too few to call a trend`);
    if (!i.data.goals.some((g) => g.latest !== null)) thin.push('no goal has a measured value yet');
    if (!i.customers || nothingToSee(i.customers)) thin.push('I can’t see any customer records yet');
    const week = weekStartUk(now);
    const hasThisWeek = (i.commitments ?? []).some((c) => c.weekStart === week);
    const question = hasThisWeek
        ? 'How are this week’s commitments going? Tell me in chat, or tick them off on my Results tab.'
        : 'What’s the one thing that would make the biggest difference to your business this week? Tell me in chat and I’ll help you turn it into a commitment.';
    // §6.1: what code can find on its own is worth saying even in a thin week — and costs nothing.
    const checks = i.content ? contentFindingsText(contentFindings(i.content)) : null;
    return {
        summary: 'Not enough data yet for a proper review — so no suggestions this week.',
        sections: [
            { title: 'What I can’t judge yet', text: `I won’t invent a trend: ${thin.join('; ')}.` },
            ...(checks ? [{ title: 'Worth fixing in your set-up', text: checks }] : []),
            { title: 'This week', text: question },
        ],
    };
}

// ── Cards the review may draw ─────────────────────────────────────────────────────────────────────

function reviewCardsPrompt(): string {
    return `CARDS — the only proposals you can make; each waits for the user's click:
A. Fill a Business Information gap (only one listed under BUSINESS INFORMATION GAPS, from facts already in the workspace):
{"type":"mentor_business_profile","summary":"...","why":"...","asked":false,"fields":{"businessDescription":"...","targetAudience":"...","industry":"...","websiteUrl":"https://..."}}
B. Add to Products & Services (only ones already named in the workspace; never a price):
{"type":"mentor_products","summary":"...","why":"...","asked":false,"products":[{"name":"...","kind":"product"|"service"}]}
C. ${mentorSetupFieldPromptLine()}
D. Who to hire next (only when WHO TO HIRE NEXT shows a clear gap):
{"type":"mentor_hire_recommendation","summary":"...","asked":false}
E. ${draftRequestPromptLine()}
Each "why" names the exact figures it is based on. "asked" is always false.`;
}

type Drawn = { card: Record<string, unknown>; kind: string; title: string; why: string; target: number | null; fields: string[] };

/** Check and rebuild one proposed card exactly as the chat route does. Null when it can't be drawn. */
async function drawCard(db: Db, orgId: number, mentorId: number, data: MentorSnapshotData, ui: unknown): Promise<Drawn | null> {
    const setupReq = setupFieldRequestFromUiElement(ui);
    if (setupReq) {
        const card = await resolveSetupFieldProposal(db, orgId, mentorId, { ...setupReq, asked: false }, { allowOthers: true });
        if ('error' in card) return null;
        return { card: { ...card }, kind: 'setup_field', title: card.summary, why: card.why, target: card.assistantId, fields: [`${card.assistantId}:${card.key}`] };
    }
    const draft = await resolveDraftRequest(db, orgId, ui);
    if (draft) {
        if ('error' in draft) return null;
        return { card: { ...draft, asked: false }, kind: 'draft_request', title: draft.summary, why: draft.why, target: draft.assistantId, fields: [`${draft.assistantId}:post`] };
    }
    const m = mentorCardFromUiElement(ui, mentorId);
    if (!m || 'error' in m) return null;
    if (m.type === 'mentor_business_profile' || m.type === 'mentor_products') {
        const kind = proposalKind(m)!;
        // A review's Business Information card fills gaps only — never overwrites what is written.
        const gapFields = m.type === 'mentor_business_profile' ? onlyGapFields(m.fields, data.business) : null;
        if (m.type === 'mentor_business_profile' && !gapFields) return null;
        const card = m.type === 'mentor_business_profile' ? { ...m, asked: false, fields: gapFields! } : { ...m, asked: false };
        const fields = m.type === 'mentor_business_profile' ? Object.keys(gapFields!).sort() : [];
        return { card, kind, title: m.summary, why: m.why, target: null, fields };
    }
    if (m.type === 'mentor_hire_recommendation') {
        const rec = recommendHires(data);
        if (!rec.picks.length) return null;
        return { card: { ...m, asked: false, why: rec.why, picks: rec.picks, capacity: rec.capacity }, kind: 'hire_recommendation', title: m.summary, why: rec.why, target: null, fields: [] };
    }
    if (m.type === 'strategy_proposal' && m.op === 'revise' && m.why) {
        const docs = await loadStrategyDocs(db, orgId).catch(() => null);
        if (!docs) return null;
        const card = buildStrategyCard({ ...m, asked: false }, docs);
        if ('error' in card) return null;
        const fields = Object.keys(card.sections ?? {}).map((k) => `${m.kind}:${k}`);
        return { card: { ...card, fields: Object.fromEntries(fields.map((f) => [f, true])) }, kind: 'strategy_revision', title: m.summary, why: m.why, target: null, fields };
    }
    return null;
}

/** Pure: is the same suggestion (kind and what it changes) still waiting for an answer? */
export function isStillWaiting(d: { kind: string; fields: string[] }, waiting: Array<{ kind: string; card: unknown }>): boolean {
    const sig = [...d.fields].sort().join();
    return waiting.some((w) => w.kind === d.kind && (proposalFields(w.card).join() === sig || (!d.fields.length && !proposalFields(w.card).length)));
}

// ── Recipients and delivery ───────────────────────────────────────────────────────────────────────

async function recipients(db: Db, orgId: number): Promise<Array<{ userId: number; email: string; firstName: string | null; emailPrefs: Record<string, boolean> | null }>> {
    const rows = await db.select({ userId: users.id, email: users.email, firstName: users.firstName, emailPrefs: userProfiles.emailPreferences })
        .from(userOrganisations)
        .innerJoin(users, eq(users.id, userOrganisations.userId))
        .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
        .where(and(eq(userOrganisations.organisationId, orgId), inArray(userOrganisations.role, REVIEW_ROLES), eq(users.status, 'active')));
    return rows;
}

/** This user's latest chat with the Mentor, or a new one: the review always lands in their chat (§2.4). */
async function mentorChatFor(db: Db, orgId: number, userId: number, mentorId: number): Promise<number> {
    const [s] = await db.select({ id: chatSessions.id }).from(chatSessions)
        .where(and(eq(chatSessions.organisationId, orgId), eq(chatSessions.userId, userId), eq(chatSessions.aiAssistantId, mentorId), eq(chatSessions.status, 'active')))
        .orderBy(desc(chatSessions.updatedAt)).limit(1);
    if (s) return s.id;
    const [created] = await db.insert(chatSessions).values({ organisationId: orgId, userId, aiAssistantId: mentorId }).returning({ id: chatSessions.id });
    return created.id;
}

/** Pure: the review as one chat message (plain text, phone-readable). */
export function reviewMessage(summary: string, sections: Array<{ title: string; text: string }>, proposalCount: number): string {
    const body = sections.filter((s) => s.text?.trim()).map((s) => `${s.title}\n${s.text.trim()}`).join('\n\n');
    const tail = proposalCount
        ? `\n\n${proposalCount === 1 ? 'One suggestion follows' : `${proposalCount} suggestions follow`} — nothing changes until you choose. They’re also in Notifications ▸ Needs you.`
        : '';
    return `Your weekly review\n\n${summary}${body ? `\n\n${body}` : ''}${tail}`;
}

// ── Queueing ─────────────────────────────────────────────────────────────────────────────────────

export interface ReviewView {
    id: number; trigger: string; weekStart: string; status: string; outcome: string | null; summary: string | null;
    sections: Array<{ title: string; text: string }>; proposals: Array<{ id: number; type: string; title: string; target: string | null; status?: string }>;
    error: string | null; createdAt: string | null; finishedAt: string | null;
    /** The reader's own chat it was posted into ("Open in chat"), or null. */
    chatSessionId: number | null;
}

export function toReviewView(r: any, userId?: number | null): ReviewView {
    const body = (r.body && typeof r.body === 'object') ? r.body : {};
    const sid = userId != null && body.sessions && typeof body.sessions === 'object' ? Number(body.sessions[String(userId)]) : NaN;
    return {
        id: r.id, trigger: r.trigger, weekStart: String(r.weekStart).slice(0, 10), status: r.status, outcome: r.outcome ?? null, summary: r.summary ?? null,
        sections: Array.isArray(body.sections) ? body.sections : [], proposals: Array.isArray(body.proposals) ? body.proposals : [],
        error: r.error ?? null, createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null, finishedAt: r.finishedAt ? new Date(r.finishedAt).toISOString() : null,
        chatSessionId: Number.isInteger(sid) && sid > 0 ? sid : null,
    };
}

async function sweepStale(db: Db, orgId?: number): Promise<void> {
    await db.update(mentorReviews).set({ status: 'failed', error: 'This took too long and was stopped. Nothing was charged.', finishedAt: new Date() })
        .where(and(...(orgId ? [eq(mentorReviews.organisationId, orgId)] : []), inArray(mentorReviews.status, ['queued', 'running']), lt(mentorReviews.createdAt, new Date(Date.now() - STALE_AFTER_MS))));
}

/** The Reviews list, newest first, with each suggestion's answer. Null when the table isn't there yet. */
export async function loadReviews(db: Db, orgId: number, userId: number | null = null, limit = 12): Promise<ReviewView[] | null> {
    try {
        await sweepStale(db, orgId);
        const rows = await db.select().from(mentorReviews).where(eq(mentorReviews.organisationId, orgId)).orderBy(desc(mentorReviews.createdAt)).limit(limit);
        const views: ReviewView[] = rows.map((r: any) => toReviewView(r, userId));
        const ids = [...new Set(views.flatMap((v) => v.proposals.map((p) => p.id)).filter((n) => Number.isInteger(n)))];
        if (ids.length) {
            const { mentorProposals } = await import('../../db/schema');
            const st = await db.select({ id: mentorProposals.id, status: mentorProposals.status }).from(mentorProposals)
                .where(and(eq(mentorProposals.organisationId, orgId), inArray(mentorProposals.id, ids)));
            const by = new Map(st.map((s: any) => [s.id, s.status]));
            for (const v of views) v.proposals = v.proposals.map((p) => ({ ...p, status: (by.get(p.id) as string | undefined) ?? 'shown' }));
        }
        return views;
    } catch (err) {
        if (missing(err)) return null;
        throw err;
    }
}

/** Wake the worker. ⚠️ Awaited (an un-awaited fetch can freeze with the lambda). Never throws. */
export async function triggerMentorReview(reviewId: number): Promise<boolean> {
    const secret = process.env.CRON_TRIGGER_SECRET;
    const baseUrl = resolveBaseUrl();
    if (!secret || !baseUrl) {
        console.error('[mentor-review] NOT dispatched — ' + (!secret ? 'CRON_TRIGGER_SECRET unset' : 'base URL unresolved'), { reviewId });
        return false;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
        const res = await fetch(`${baseUrl}/.netlify/functions/mentor-review-background`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
            body: JSON.stringify({ reviewId }), signal: controller.signal,
        });
        if (res.status !== 202 && !res.ok) { console.error('[mentor-review] worker refused the dispatch', { reviewId, status: res.status }); return false; }
        return true;
    } catch (err) {
        console.error('[mentor-review] dispatch failed', { reviewId, err: err instanceof Error ? err.message : err });
        return false;
    } finally {
        clearTimeout(timer);
    }
}

export type QueueReviewResult = { ok: true; review: ReviewView } | { ok: false; status: number; error: string; code?: string };

/** "Review my week now" — the Overview tab's button (mentor.ts `review_now`). Owners and admins only (§2.5). */
export async function queueReviewNow(db: Db, orgId: number, userId: number, role: string | null | undefined, now = new Date()): Promise<QueueReviewResult> {
    if (!REVIEW_ROLES.includes(String(role))) return { ok: false, status: 403, error: 'Only the workspace owner or an admin can ask for a review — it goes to them.' };
    if (await isGlobalAiDisabled()) return { ok: false, status: 503, error: 'AI services are temporarily unavailable. Please try again later.' };
    const [mentor] = await db.select({ id: aiAssistants.id }).from(aiAssistants)
        .where(and(eq(aiAssistants.organisationId, orgId), sql`${aiAssistants.configuration} ->> 'type' = ${MENTOR_ROLE_KEY}`)).limit(1);
    if (!mentor) return { ok: false, status: 404, error: 'This workspace has no Business Mentor yet.' };
    try {
        const usage = await getTaskUsage(db, orgId);
        if (!usage.hasPlan) return { ok: false, status: 403, code: 'UPGRADE_REQUIRED', error: 'Weekly reviews need a paid plan. You can still ask your Mentor questions about Be More Swan.' };
        if (usage.remaining !== null && usage.remaining < 1) return { ok: false, status: 403, code: 'TASK_LIMIT', error: TASK_LIMIT_MESSAGE };
    } catch (err) {
        console.error('[mentor-review] task check failed — allowing the review', err instanceof Error ? err.message : err);
    }
    let row: any;
    try {
        await sweepStale(db, orgId);
        const [{ open }] = await db.select({ open: sql<number>`count(*)::int` }).from(mentorReviews)
            .where(and(eq(mentorReviews.organisationId, orgId), inArray(mentorReviews.status, ['queued', 'running']), gt(mentorReviews.createdAt, new Date(Date.now() - STALE_AFTER_MS))));
        if (Number(open) > 0) return { ok: false, status: 429, error: 'A review is already being written — it’ll be in your chat in a minute or two.' };
        [row] = await db.insert(mentorReviews).values({ organisationId: orgId, aiAssistantId: mentor.id, requestedBy: userId, trigger: 'on_demand', weekStart: weekStartUk(now) }).returning();
    } catch (err) {
        if (missing(err)) return { ok: false, status: 503, error: NOT_READY };
        throw err;
    }
    if (!(await triggerMentorReview(row.id))) {
        await db.update(mentorReviews).set({ status: 'failed', error: 'It couldn’t be started. Nothing was charged.', finishedAt: new Date() }).where(eq(mentorReviews.id, row.id));
        return { ok: false, status: 503, error: 'Your Mentor couldn’t start the review just now. Nothing was charged — please try again.' };
    }
    return { ok: true, review: toReviewView(row) };
}

/** The daily dispatch: queue every workspace whose review is due today (§5). Never throws per workspace. */
export async function dispatchDueReviews(db: Db, now = new Date()): Promise<{ considered: number; due: number; queued: number; skippedCap: number; failedToStart: number; ready: boolean }> {
    const out = { considered: 0, due: 0, queued: 0, skippedCap: 0, failedToStart: 0, ready: true };
    const week = weekStartUk(now);
    let mentors: any[];
    try {
        await sweepStale(db);
        mentors = await db.select({
            id: aiAssistants.id, orgId: aiAssistants.organisationId, ctx: aiAssistants.onboardingContext, life: aiAssistants.lifecycleStatus,
            // A failed scheduled review doesn't count: it is tried again on the next tick that week.
            last: sql<string | null>`(SELECT max(r.week_start)::text FROM mentor_reviews r WHERE r.organisation_id = ${aiAssistants.organisationId} AND r.trigger = 'schedule' AND r.status <> 'failed')`,
        }).from(aiAssistants)
            .where(and(sql`${aiAssistants.configuration} ->> 'type' = ${MENTOR_ROLE_KEY}`, sql`coalesce(${aiAssistants.lifecycleStatus}, '') <> 'archived'`));
    } catch (err) {
        if (missing(err)) { out.ready = false; return out; }
        throw err;
    }
    for (const m of mentors) {
        out.considered++;
        if (!isReviewDue(reviewSettings(m.ctx), m.last, now)) continue;
        out.due++;
        if (out.queued >= MAX_PER_TICK) continue;
        try {
            const usage = await getTaskUsage(db, m.orgId).catch(() => null);
            // §2.7: no paid plan, no review. §2.1: at the cap, skipped (it isn't queued, so it isn't charged).
            if (usage && !usage.hasPlan) continue;
            if (usage && usage.remaining !== null && usage.remaining < 1) { out.skippedCap++; continue; }
            await db.delete(mentorReviews).where(and(eq(mentorReviews.organisationId, m.orgId), eq(mentorReviews.trigger, 'schedule'), eq(mentorReviews.weekStart, week), eq(mentorReviews.status, 'failed')));
            const [row] = await db.insert(mentorReviews).values({ organisationId: m.orgId, aiAssistantId: m.id, trigger: 'schedule', weekStart: week })
                .onConflictDoNothing().returning({ id: mentorReviews.id });
            if (!row) continue;
            if (await triggerMentorReview(row.id)) out.queued++;
            else {
                out.failedToStart++;
                // Free the week's slot so the next tick tries again.
                await db.delete(mentorReviews).where(eq(mentorReviews.id, row.id));
            }
        } catch (err) {
            console.error('[mentor-review] dispatch failed for org', m.orgId, err instanceof Error ? err.message : err);
        }
    }
    return out;
}

// ── The worker ───────────────────────────────────────────────────────────────────────────────────

/** Write one review to the end. Called by mentor-review-background.ts. Never throws; always ends the row. */
export async function runMentorReview(db: Db, reviewId: number, now = new Date()): Promise<void> {
    let review: any;
    try {
        [review] = await db.update(mentorReviews).set({ status: 'running', startedAt: new Date() })
            .where(and(eq(mentorReviews.id, reviewId), eq(mentorReviews.status, 'queued'))).returning();
    } catch (err) {
        console.error('[mentor-review] could not claim review', reviewId, err);
        return;
    }
    if (!review) return;
    const orgId: number = review.organisationId;
    try {
        const [mentor] = await db.select({ id: aiAssistants.id, name: aiAssistants.name, ctx: aiAssistants.onboardingContext })
            .from(aiAssistants).where(and(eq(aiAssistants.id, review.aiAssistantId ?? 0), eq(aiAssistants.organisationId, orgId))).limit(1);
        if (!mentor) throw new Error('no Mentor');
        const settings = reviewSettings(mentor.ctx);
        if (review.trigger === 'schedule' && (!settings.on || settings.quiet)) {
            await db.update(mentorReviews).set({ status: 'failed', error: 'Skipped: Quiet mode is on or the weekly review is off.', finishedAt: new Date() }).where(eq(mentorReviews.id, reviewId));
            return;
        }
        const people = await recipients(db, orgId);
        const readerId = review.requestedBy ?? people[0]?.userId;
        if (!readerId) throw new Error('no owner or admin to send it to');
        const name = mentor.name || 'Your Mentor';
        const inputs = await readReviewInputs(db, orgId, readerId, now);
        const [org] = await db.select({ name: organisations.name }).from(organisations).where(eq(organisations.id, orgId)).limit(1);

        let summary: string;
        let sections: Array<{ title: string; text: string }>;
        let outcome: 'reviewed' | 'not_enough_data';
        let drawn: Drawn[] = [];
        let charged = false;
        let commitmentCard: Record<string, unknown> | null = null;

        if (!hasEnoughData(inputs, now)) {
            ({ summary, sections } = notEnoughDataReview(inputs, now));
            outcome = 'not_enough_data';
        } else {
            const left = inputs.proposals ? Math.max(0, WEEKLY_CAP - inputs.proposals.usedThisWeek) : 1;
            const stillOpen = await loadOpenProposals(db, orgId);
            const waitingLine = stillOpen.length
                ? `STILL WAITING FOR THEIR ANSWER (never propose these again; you may remind them in words): ${stillOpen.slice(0, 8).map((o) => o.title).join(' | ')}`
                : '';
            const system = [
                `You are ${name}, the Business Mentor of ${org?.name || 'this business'} on Be More Swan.`,
                MENTOR_REVIEW_CRAFT, MENTOR_HONESTY_RULES,
                renderMentorSnapshot(inputs.data), renderProposalState(inputs.proposals, now),
                renderFigures(inputs.figures, inputs.data).join('\n'),
                renderCommitmentsForMentor(inputs.commitments, null, now).join('\n'),
                renderTrackRecordForMentor(inputs.record).join('\n'),
                renderCustomersForMentor(inputs.customers).join('\n'),
                renderContentChecksForMentor(inputs.content ?? null).join('\n'),
                `SUGGESTIONS LEFT THIS WEEK: ${left}.`,
                waitingLine,
                reviewCardsPrompt(),
                `Return STRICT JSON only: {"summary": "<two sentences: the headline of the week>", "sections": [{"title": "What went well", "text": "..."}, {"title": "What needs attention", "text": "..."}, {"title": "Since my last suggestions", "text": "..."}, {"title": "Commitments", "text": "..."}, {"title": "Your customers", "text": "..."}], "proposals": [<0 to ${left} cards>], "commitments": ["<1 to 3 small things for this week, the same ones you suggest under Commitments>"]}. Leave out a section with nothing true to say. "commitments" is saved only if they choose, from a card under the review.`,
            ].join('\n\n');
            const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
            const { response, model } = await withRoleModel(
                await loadRoleModel(db, MENTOR_ROLE_KEY), REVIEW_DEFAULT_MODEL,
                async (m, thinking) => ({ model: m, response: await anthropic.messages.create(adaptForModel({
                    model: m, max_tokens: 4000, system: sanitizeForModel(system),
                    messages: sanitizeForModel([{ role: 'user' as const, content: 'Write this week\'s review now.' }]),
                }, m, thinking) as Anthropic.MessageCreateParamsNonStreaming, { timeout: 240_000 }) }),
                { label: 'mentor weekly review' },
            );
            void logAiUsage({
                workspaceId: orgId, userId: readerId, assistantId: mentor.id, model,
                inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens,
                sessionId: `mentor:review:${reviewId}`, dataCategories: ['business_context'],
            });
            const parsed = parseModelJson<{ summary?: unknown; sections?: unknown; proposals?: unknown; commitments?: unknown }>(replyText(response.content));
            if (!parsed || typeof parsed.summary !== 'string' || !parsed.summary.trim()) throw new Error('The review came back empty.');
            summary = parsed.summary.trim().slice(0, 600);
            sections = (Array.isArray(parsed.sections) ? parsed.sections : []).flatMap((s: any) => (
                s && typeof s.title === 'string' && typeof s.text === 'string' && s.text.trim() ? [{ title: s.title.trim().slice(0, 80), text: s.text.trim().slice(0, 1500) }] : []
            )).slice(0, 6);
            outcome = 'reviewed';
            charged = true;
            // §5.1: the commitments it suggests, as the chat's own card — the user's to save, never a suggestion.
            const c = cleanCommitmentTexts(parsed.commitments);
            if (c.ok) commitmentCard = { type: 'mentor_commitments', op: 'set', summary: 'Save these as this week’s commitments?', texts: c.texts };

            // Proposals: checked and rebuilt like chat cards; 3 a week and no dismissed kind (§3.13).
            const state: ProposalState = inputs.proposals ?? { usedThisWeek: 0, dismissed: [] };
            // Never repeat a suggestion still waiting for an answer (staging, 26 Oct: a second identical post request).
            const waiting = await loadOpenProposals(db, orgId);
            for (const ui of (Array.isArray(parsed.proposals) ? parsed.proposals : []).slice(0, WEEKLY_CAP)) {
                const d = await drawCard(db, orgId, mentor.id, inputs.data, ui).catch(() => null);
                if (!d || !d.why) continue;
                if (d.target && !inputs.data.team.some((t) => t.id === d.target && t.state === 'active')) continue;
                if (drawn.some((x) => x.kind === d.kind && x.fields.join() === d.fields.join())) continue;
                if (isStillWaiting(d, waiting)) continue;
                if (!gateSuggestion({ kind: d.kind, fields: d.fields, asked: false }, state, now).ok) continue;
                drawn.push(d);
                state.usedThisWeek++;
            }
        }

        // Deliver: the review message, then each card, in every owner's and admin's chat with the Mentor.
        const sessions = new Map<number, number>();
        for (const p of people) sessions.set(p.userId, await mentorChatFor(db, orgId, p.userId, mentor.id));
        const firstSession = sessions.get(readerId) ?? [...sessions.values()][0] ?? null;
        const recorded: Array<{ id: number; card: Record<string, unknown>; type: string; title: string; target: string | null }> = [];
        for (const d of drawn) {
            const id = await recordMentorProposal(db, {
                organisationId: orgId, aiAssistantId: mentor.id, kind: d.kind, title: d.title, why: d.why,
                payload: { ...d.card, fields: d.card.fields ?? Object.fromEntries(d.fields.map((f) => [f, true])), fromReview: reviewId },
                chatSessionId: firstSession, targetAssistantId: d.target,
            });
            if (!id) continue;
            const targetName = d.target ? inputs.data.team.find((t) => t.id === d.target)?.name ?? null : null;
            recorded.push({ id, card: { ...d.card, proposalId: id }, type: String(d.card.type), title: d.title, target: targetName });
        }
        const text = reviewMessage(summary, sections, recorded.length);
        for (const sid of sessions.values()) {
            await db.insert(chatMessages).values({ chatSessionId: sid, role: 'assistant', content: text, uiElementJson: null });
            for (const [i, r] of recorded.entries()) {
                await db.insert(chatMessages).values({ chatSessionId: sid, role: 'assistant', content: recorded.length > 1 ? `Suggestion ${i + 1} of ${recorded.length}` : 'My suggestion this week', uiElementJson: r.card });
            }
            if (commitmentCard) await db.insert(chatMessages).values({ chatSessionId: sid, role: 'assistant', content: 'Your commitments for this week', uiElementJson: commitmentCard });
            await db.update(chatSessions).set({ updatedAt: new Date() }).where(eq(chatSessions.id, sid));
        }

        await db.update(mentorReviews).set({
            status: 'done', outcome, summary, finishedAt: new Date(), proposalIds: recorded.map((r) => r.id),
            body: {
                sections, figures: inputs.figures, proposals: recorded.map((r) => ({ id: r.id, type: r.type, title: r.title, target: r.target })),
                // Each recipient's chat it was posted into — "Open in chat" on the Reviews list and the notification.
                sessions: Object.fromEntries([...sessions.entries()].map(([u, sid]) => [String(u), sid])),
            },
        }).where(eq(mentorReviews.id, reviewId));
        if (charged) await recordCompletedWork(db, orgId, 'mentor_review', { assistantId: mentor.id, ref: `mentor_review:${reviewId}` });

        // Tell each recipient by their own settings (§2.4): in-app (filtered on read by their preference) and email.
        const base = resolveBaseUrl() || process.env.BASE_URL || '';
        const proposalsLine = recorded.length ? `${recorded.length} suggestion${recorded.length === 1 ? '' : 's'} to look at` : 'no suggestions this week';
        for (const p of people) {
            await createNotification(db, 'mentor_weekly_review', {
                userId: p.userId, assistantId: mentor.id, category: 'state_change',
                context: { assistant: { name }, review: { summary: shortQuestion(summary, 200), proposals: proposalsLine } },
                metadata: { assistantId: mentor.id, mentorReviewId: reviewId, chatSessionId: sessions.get(p.userId) ?? null },
            });
            if (isEmailEnabled(p.emailPrefs, 'mentor_weekly_review')) {
                await sendTemplatedEmail({
                    triggerKey: 'mentor_weekly_review', to: p.email,
                    vars: {
                        user: { first_name: p.firstName ?? '' }, assistant: { name }, workspace: { name: org?.name ?? '' },
                        review: { summary, proposals: proposalsLine },
                        link: { action_url: `${base}/workspace.html` },
                    },
                }).catch((err: unknown) => console.warn('[mentor-review] email failed for user', p.userId, err instanceof Error ? err.message : err));
            }
        }
    } catch (err) {
        console.error('[mentor-review] review failed', { reviewId, message: err instanceof Error ? err.message : String(err) });
        await recordPlatformIncident(db, { kind: 'mentor_review', error: err, organisationId: orgId, assistantId: review.aiAssistantId ?? null, role: 'business_mentor', ids: { reviewId, trigger: review.trigger }, view: 'mentor-review-background' });
        await db.update(mentorReviews).set({ status: 'failed', error: 'Your Mentor couldn’t finish this review. Nothing was charged.', finishedAt: new Date() })
            .where(eq(mentorReviews.id, reviewId)).catch(() => {});
    }
}


/** Pure: the Mentor's own review settings, for its chat prompt — and how to change them with the set-up card. */
export function renderReviewSettingsForMentor(mentorId: number, ctx: unknown): string {
    const st = reviewSettings(ctx);
    const state = st.quiet ? 'off while Quiet mode is on' : st.on ? `on, every ${st.day[0].toUpperCase()}${st.day.slice(1)}` : 'switched off';
    return `YOUR WEEKLY REVIEW: ${state}. It goes to the workspace's owners and admins, in their chat with you, and its suggestions also wait in Notifications ▸ Needs you; how each is told is "Business Mentor weekly review" in My Account ▸ Notifications. An owner or admin can ask for one now with "Review my week now" on your Overview tab (1 task). To change the day or switch it off when they ask, use setup_field_proposal with assistantId ${mentorId} and key "reviewDay" ("Monday" … "Sunday") or "weeklyReview" ("on" / "off"), "asked": true.`;
}
