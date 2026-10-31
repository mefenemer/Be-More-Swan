// src/utils/team-messages.ts
// The Team feed — docs/campaign-orchestrator-flow.md §4. The ONLY writer of team_messages.
//
// Found approving prod campaign 1 (2026-10-14): six briefs went to five assistants and nothing on
// any of their pages said so. The work was happening; nobody could see it.
//
// ── The rule that makes it trustworthy ───────────────────────────────────────────────────────────
// An assistant's message is written at the moment the state it describes actually changed —
// order placed, issued, waiting, drafted, done, cancelled — never by a model. "Working on it" while
// a job sits queued is the failure chat-claims-drafts-it-never-saved is named after; this feed
// cannot say it, because nothing here composes prose from intentions.
//
// A person's message is theirs, word for word. Its effect is real and stated: a note to an
// assistant on a campaign reaches that assistant's drafting through the campaign directive
// (ownerNotesFor → blueprint section 13), and every assistant's chat reads its own thread.
//
// ── The one place a model writes here: a reply to a person (2026-10-22) ─────────────────────────
// A person's note gets a REAL answer: the Team page runs a chat turn for it (chat-orchestrator.ts,
// `teamMessageId`) in the assistant's newest conversation, and postTeamChatReply() writes that turn's
// reply here as kind 'reply', pointing at the chat message. That reply went through every guard the
// chat has (unbacked-draft claims, cards rebuilt from rows), and any card it carries — a settings or
// rule change, an action on a post — is the chat's own card, confirmed by a click. Messages about
// WORK (brief, started, ready, done…) are still never composed by a model.
//
// Questions carry answer buttons. Each question KEY has one handler here, and answering runs it —
// "Start now?" releases the waiting work; "Video too?" adds video to the brief.
//
// Never throws on the write path: a feed message must never fail the work it describes.

import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, campaignOrders, campaigns, chatMessages, chatSessions, contentGenerationJobs, teamMessages, teamReads, visualBriefs } from '../../db/schema';
import { ORDER_ACTION_SPECS, isOrderAction } from '../config/campaign-vocab';
import { asksForACall } from './callback-request';

type Db = ReturnType<typeof getDb>;

export type TeamKind = 'brief' | 'started' | 'waiting' | 'ready' | 'done' | 'cancelled' | 'question' | 'message' | 'reply';
/** `callback`: open Help & Support's "Request a call back" form (src/utils/callback-request.ts). */
export interface TeamLink {
    assistantId: number; tab?: string; chat?: boolean; callback?: boolean; label: string;
    /** A model reply (postTeamChatReply): the chat message that holds it and its card, and the note it answers. */
    chatSessionId?: number; chatMessageId?: number; replyTo?: number;
}
export interface TeamQuestion { key: QuestionKey; ref: number; choices: Array<{ value: string; label: string }> }
export type QuestionKey = 'start_now' | 'brief_video';

/** Longest message a person may send; the feed is for notes, not documents. */
export const MAX_MESSAGE_CHARS = 1000;
/** How many of a person's recent notes reach an assistant's drafting for one campaign. */
const OWNER_NOTES_IN_DIRECTIVE = 5;

export interface PostInput {
    organisationId: number;
    campaignId?: number | null;
    campaignOrderId?: number | null;
    fromAssistantId?: number | null;
    fromUserId?: number | null;
    toAssistantId?: number | null;
    toUser?: boolean;
    kind: TeamKind;
    body: string;
    link?: TeamLink | null;
    question?: TeamQuestion | null;
}

/** Write one message. Returns its id, or null. Never throws. */
export async function postTeamMessage(db: Db, m: PostInput): Promise<number | null> {
    try {
        const [row] = await db.insert(teamMessages).values({
            organisationId: m.organisationId,
            campaignId: m.campaignId ?? null,
            campaignOrderId: m.campaignOrderId ?? null,
            fromAssistantId: m.fromAssistantId ?? null,
            fromUserId: m.fromUserId ?? null,
            toAssistantId: m.toAssistantId ?? null,
            toUser: !!m.toUser,
            kind: m.kind,
            body: m.body.slice(0, 2000),
            link: m.link ?? null,
            question: m.question ?? null,
        }).returning({ id: teamMessages.id });
        return row?.id ?? null;
    } catch (err) {
        console.error('[team-messages] post failed (the work itself is unaffected):', m.kind, err instanceof Error ? err.message : err);
        return null;
    }
}

/**
 * Write a message about an order at most ONCE per kind. The reconciler re-judges orders every hour,
 * and the drafting worker and the reconciler can both notice "ready" — one message, not three.
 */
async function postOncePerOrder(db: Db, orderId: number, m: PostInput): Promise<void> {
    try {
        const [seen] = await db.select({ id: teamMessages.id }).from(teamMessages)
            .where(and(eq(teamMessages.campaignOrderId, orderId), eq(teamMessages.kind, m.kind))).limit(1);
        if (seen) return;
    } catch { /* a failed check must not stop the message */ }
    await postTeamMessage(db, { ...m, campaignOrderId: orderId });
}

// ── What each order says, at each step ──────────────────────────────────────────────────────────

function labelOf(action: string): string {
    return isOrderAction(action) ? ORDER_ACTION_SPECS[action].label : action;
}
function plural(n: number, one: string, many: string): string { return `${n} ${n === 1 ? one : many}`; }
function qty(brief: Record<string, unknown>): number { return Math.max(1, Math.floor(Number(brief.quantity) || 1)); }

/** Where a role's finished work is reviewed — the same tabs campaign-work-state.ts links to. */
const REVIEW_TAB: Record<string, { tab: string; label: string }> = {
    draft_social_posts: { tab: 'review-queue', label: 'Review the posts' },
    ab_test_posts: { tab: 'review-queue', label: 'Review the posts' },
    draft_blog_pillar: { tab: 'review-queue', label: 'Review the articles' },
    draft_email_campaign: { tab: 'email-campaigns', label: 'Review the emails' },
    commission_visuals: { tab: 'briefs', label: 'Open the brief' },
    commission_video: { tab: 'videos', label: 'Open the video' },
    run_lead_search: { tab: 'signals', label: 'Open the search' },
};

interface OrderCtx {
    organisationId: number; campaignId: number; orderId: number; action: string;
    orchestratorAssistantId: number; targetAssistantId: number | null; brief: Record<string, unknown>;
    objective: string;
}

/** The Campaign Assistant briefs a colleague. Written when the order is placed. */
export async function noteOrderPlaced(db: Db, o: OrderCtx & { waitingFor?: { position: number | null; action: string } | null }): Promise<void> {
    if (!o.targetAssistantId) return;
    const n = qty(o.brief);
    const spec = isOrderAction(o.action) ? ORDER_ACTION_SPECS[o.action] : null;
    const what = `${labelOf(o.action)}${spec?.takesQuantity && n > 1 ? ` ×${n}` : ''}`;
    await postTeamMessage(db, {
        organisationId: o.organisationId, campaignId: o.campaignId, campaignOrderId: o.orderId,
        fromAssistantId: o.orchestratorAssistantId, toAssistantId: o.targetAssistantId,
        kind: 'brief', body: `Brief: ${what}, for “${o.objective}”.`,
    });
    if (o.waitingFor) {
        const which = o.waitingFor.position ? `item ${o.waitingFor.position}, ${labelOf(o.waitingFor.action).toLowerCase()}` : 'earlier work';
        await postTeamMessage(db, {
            organisationId: o.organisationId, campaignId: o.campaignId, campaignOrderId: o.orderId,
            fromAssistantId: o.targetAssistantId, toUser: true, kind: 'question',
            body: `Got it. This waits for ${which}, so I have not started yet. Shall I start now instead?`,
            question: { key: 'start_now', ref: o.orderId, choices: [{ value: 'start', label: 'Start now' }, { value: 'wait', label: 'Keep waiting' }] },
        });
    }
}

/** The colleague has taken the work on. Written when the order is ISSUED (now, or released later). */
export async function noteOrderIssued(db: Db, o: OrderCtx & { summary?: string | null }): Promise<void> {
    if (!o.targetAssistantId) return;
    const n = qty(o.brief);
    const base = { organisationId: o.organisationId, campaignId: o.campaignId, fromAssistantId: o.targetAssistantId };
    switch (o.action) {
        case 'draft_social_posts':
        case 'ab_test_posts':
            return postOncePerOrder(db, o.orderId, { ...base, toAssistantId: o.orchestratorAssistantId, kind: 'started',
                body: `On it — ${plural(o.action === 'ab_test_posts' ? n * 2 : n, 'post is', 'posts are')} queued for drafting and should start within about 10 minutes. Each one comes to you for review.` });
        case 'draft_blog_pillar':
            return postOncePerOrder(db, o.orderId, { ...base, toAssistantId: o.orchestratorAssistantId, kind: 'started',
                body: `On it — ${plural(n, 'article is', 'articles are')} queued for writing. ${n === 1 ? 'It comes' : 'They come'} to you for review.` });
        case 'draft_email_campaign':
            return postOncePerOrder(db, o.orderId, { ...base, toAssistantId: o.orchestratorAssistantId, kind: 'started',
                body: 'On it — writing the emails now. They stay switched off in Email Studio until you review them.' });
        case 'adjust_messaging':
        case 'narrow_targeting':
            return postOncePerOrder(db, o.orderId, { ...base, toAssistantId: o.orchestratorAssistantId, kind: 'done',
                body: 'Done — this applies to what I do from now on. Nothing already drafted is rewritten.' });
        case 'run_lead_search':
            return postOncePerOrder(db, o.orderId, { ...base, toUser: true, kind: 'ready',
                body: 'I have saved the search as a draft. Start it when you are ready — a run costs money and reaches real people, so it never starts itself.',
                link: { assistantId: o.targetAssistantId, tab: 'signals', label: 'Open the search' } });
        case 'commission_visuals': {
            const many = n > 1 ? ` — ${n} pictures, one for each post` : '';
            // A brief with only free sources starts its first round at once (campaign-orders.ts), so
            // say what is ACTUALLY happening: "ask me for options" while they were already being made
            // sent the person to press a button that was greyed out (found on prod, 2026-10-14).
            const [b] = await db.select({ status: visualBriefs.status }).from(visualBriefs)
                .where(and(eq(visualBriefs.campaignOrderId, o.orderId), eq(visualBriefs.organisationId, o.organisationId))).limit(1);
            const making = b?.status === 'generating';
            await postOncePerOrder(db, o.orderId, { ...base, toUser: true, kind: 'started',
                body: making
                    ? `Your brief is ready${many}. I am making the first options now — free stock photos and branded cards — and they will be on my Briefs tab in about a minute. Choose the ones you like.`
                    : `Your brief is ready${many}. Ask me for options on my Briefs tab and choose the ones you like.`,
                link: { assistantId: o.targetAssistantId, tab: 'briefs', label: 'Open the brief' } });
            await askAboutVideo(db, { ...o, targetAssistantId: o.targetAssistantId });
            return;
        }
        // Video Producer, Phase 7: the storyboard is planned at once (free); making it is their click.
        case 'commission_video':
            return postOncePerOrder(db, o.orderId, { ...base, toUser: true, kind: 'started',
                body: 'On it — I am planning the storyboard now, free. It will be on my Videos tab in about a minute: check the scenes, then press “Make the video” — that is where any AI credits are shown.',
                link: { assistantId: o.targetAssistantId, tab: 'videos', label: 'Open the video' } });
        default:
            return;
    }
}

/** A picture brief that makes no video asks whether the person wants some (owner, 2026-10-14). */
async function askAboutVideo(db: Db, o: OrderCtx & { targetAssistantId: number }): Promise<void> {
    try {
        const [brief] = await db.select({ id: visualBriefs.id, sources: visualBriefs.sources }).from(visualBriefs)
            .where(and(eq(visualBriefs.campaignOrderId, o.orderId), eq(visualBriefs.organisationId, o.organisationId))).limit(1);
        const sources = Array.isArray(brief?.sources) ? (brief!.sources as string[]) : [];
        if (!brief || sources.includes('stock_video') || sources.includes('ai_video')) return;
        await postTeamMessage(db, {
            organisationId: o.organisationId, campaignId: o.campaignId, campaignOrderId: o.orderId,
            fromAssistantId: o.targetAssistantId, toUser: true, kind: 'question',
            body: 'This brief makes pictures only. Would you like video options as well?',
            question: { key: 'brief_video', ref: brief.id, choices: [
                { value: 'stock_video', label: 'Yes — stock video (free)' },
                { value: 'ai_video', label: 'Yes — AI video (uses AI credits)' },
                { value: 'none', label: 'No, pictures only' },
            ] },
        });
    } catch (err) {
        console.error('[team-messages] video question skipped:', err instanceof Error ? err.message : err);
    }
}

/** The order's outcome, from the reconciler or the drafting worker. One message per outcome. */
export async function noteOrderSettled(db: Db, o: {
    organisationId: number; campaignId: number; orderId: number; action: string; targetAssistantId: number | null;
    kind: 'ready' | 'done' | 'cancelled'; summary: string;
}): Promise<void> {
    if (!o.targetAssistantId) return;
    const review = REVIEW_TAB[o.action];
    await postOncePerOrder(db, o.orderId, {
        organisationId: o.organisationId, campaignId: o.campaignId, fromAssistantId: o.targetAssistantId, toUser: true,
        kind: o.kind,
        body: o.kind === 'ready' ? `Ready for you: ${o.summary.replace(/[.\s]*$/, '')}.`
            : o.kind === 'done' ? `Done: ${o.summary.replace(/[.\s]*$/, '')}.`
            : `I could not do this: ${o.summary.replace(/[.\s]*$/, '')}.`,
        link: review && o.kind !== 'cancelled' ? { assistantId: o.targetAssistantId, ...review } : null,
    });
}

/**
 * Called by the drafting worker when a campaign job finishes: when it was the LAST of its order,
 * the assistant says the work is ready — within minutes, rather than at the hourly reconcile.
 */
export async function noteJobFinished(db: Db, campaignOrderId: number | null | undefined): Promise<void> {
    if (!campaignOrderId) return;
    try {
        const [row] = await db.select({
            open: sql<number>`(count(*) FILTER (WHERE ${contentGenerationJobs.status} IN ('queued', 'processing')))::int`,
            done: sql<number>`(count(*) FILTER (WHERE ${contentGenerationJobs.status} = 'completed'))::int`,
        }).from(contentGenerationJobs).where(eq(contentGenerationJobs.campaignOrderId, campaignOrderId));
        if (!row || Number(row.open) > 0 || Number(row.done) === 0) return;
        const [o] = await db.select({
            id: campaignOrders.id, organisationId: campaignOrders.organisationId, campaignId: campaignOrders.campaignId,
            action: campaignOrders.action, targetAssistantId: campaignOrders.targetAssistantId,
        }).from(campaignOrders).where(eq(campaignOrders.id, campaignOrderId)).limit(1);
        if (!o) return;
        const n = Number(row.done);
        const noun = o.action === 'draft_blog_pillar' ? plural(n, 'article', 'articles') : plural(n, 'post', 'posts');
        await noteOrderSettled(db, { ...o, orderId: o.id, kind: 'ready', summary: `${noun} drafted and waiting for your review` });
    } catch (err) {
        console.error('[team-messages] job-finished note skipped:', err instanceof Error ? err.message : err);
    }
}

/** noteJobFinished, from a job row id (the drafting workers hold raw rows). Never throws. */
export async function noteJobRowFinished(db: Db, jobRowId: number): Promise<void> {
    try {
        const [j] = await db.select({ orderId: contentGenerationJobs.campaignOrderId }).from(contentGenerationJobs)
            .where(eq(contentGenerationJobs.id, jobRowId)).limit(1);
        await noteJobFinished(db, j?.orderId ?? null);
    } catch { /* the feed never fails a job */ }
}

// ── A person's notes reaching the work ──────────────────────────────────────────────────────────

/**
 * What the person has told THIS assistant about THIS campaign, newest first — rendered into the
 * campaign directive (blueprint section 13), so a note in Team changes what is drafted next.
 */
export async function ownerNotesFor(db: Db, campaignId: number, assistantId: number): Promise<string[]> {
    try {
        const rows = await db.select({ body: teamMessages.body }).from(teamMessages)
            .where(and(
                eq(teamMessages.campaignId, campaignId), eq(teamMessages.toAssistantId, assistantId),
                eq(teamMessages.kind, 'message'), sql`${teamMessages.fromUserId} IS NOT NULL`,
            ))
            .orderBy(desc(teamMessages.id)).limit(OWNER_NOTES_IN_DIRECTIVE);
        return rows.map((r) => r.body);
    } catch {
        return [];
    }
}

/** An assistant's recent Team thread, as a block for its chat prompt. '' when there is none. */
export async function teamThreadPromptBlock(db: Db, organisationId: number, assistantId: number): Promise<string> {
    try {
        const rows = await db.select({ body: teamMessages.body, kind: teamMessages.kind, fromUserId: teamMessages.fromUserId, fromAssistantId: teamMessages.fromAssistantId, createdAt: teamMessages.createdAt })
            .from(teamMessages)
            .where(and(eq(teamMessages.organisationId, organisationId),
                or(eq(teamMessages.fromAssistantId, assistantId), eq(teamMessages.toAssistantId, assistantId))))
            .orderBy(desc(teamMessages.id)).limit(12);
        if (!rows.length) return '';
        const lines = rows.reverse().map((r) => `- ${r.createdAt.toISOString().slice(0, 16).replace('T', ' ')} ${r.fromUserId ? 'The user' : r.fromAssistantId === assistantId ? 'You' : 'A colleague'}: ${r.body}`);
        return `YOUR TEAM THREAD (the "Team Chat" page — messages between you, your colleagues and the user; most recent last). The user's messages here are instructions to you; follow them. Do not repeat these back unless asked.\n${lines.join('\n')}`;
    } catch {
        return '';
    }
}

// ── Reading, sending, answering (netlify/functions/team.ts) ─────────────────────────────────────

export interface TeamMessageView {
    id: number; createdAt: string; kind: string; body: string;
    /** A model reply's card (the chat message's uiElement), so the feed can show it in place. */
    card: unknown | null;
    campaignId: number | null; campaignOrderId: number | null;
    from: { kind: 'assistant' | 'user'; id: number | null; name: string; roleKey: string | null };
    to: { kind: 'assistant' | 'user' | 'none'; id: number | null; name: string | null };
    link: TeamLink | null;
    question: (TeamQuestion & { answered: boolean; answer: string | null }) | null;
}

/** A question to the person that nobody has answered yet. It needs them until it is answered, not
 *  until it is seen — opening the page used to read it, and the badge forgot it was waiting. */
const OPEN_QUESTION = sql`(${teamMessages.toUser} = true AND ${teamMessages.question} IS NOT NULL AND ${teamMessages.answeredAt} IS NULL)`;

export async function listTeamMessages(db: Db, orgId: number, filter: { campaignId?: number; assistantId?: number; mine?: boolean; openQuestions?: boolean; beforeId?: number; limit?: number }): Promise<TeamMessageView[]> {
    const conds = [eq(teamMessages.organisationId, orgId)];
    // "Me": everything addressed to the person or written by them — their own inbox and outbox.
    if (filter.mine) conds.push(or(eq(teamMessages.toUser, true), sql`${teamMessages.fromUserId} IS NOT NULL`)!);
    // Questions still waiting for the person: the Notifications page's "Needs you" view, however old.
    if (filter.openQuestions) conds.push(OPEN_QUESTION);
    if (filter.campaignId) conds.push(eq(teamMessages.campaignId, filter.campaignId));
    if (filter.assistantId) conds.push(or(eq(teamMessages.fromAssistantId, filter.assistantId), eq(teamMessages.toAssistantId, filter.assistantId))!);
    if (filter.beforeId) conds.push(lt(teamMessages.id, filter.beforeId));
    const rows = await db.select().from(teamMessages).where(and(...conds)).orderBy(desc(teamMessages.id)).limit(Math.min(300, filter.limit ?? 200));
    const ids = [...new Set(rows.flatMap((r) => [r.fromAssistantId, r.toAssistantId]).filter((x): x is number => !!x))];
    const names = new Map<number, { name: string; roleKey: string | null }>();
    if (ids.length) {
        const as = await db.select({ id: aiAssistants.id, name: aiAssistants.name, type: sql<string | null>`${aiAssistants.configuration} ->> 'type'` })
            .from(aiAssistants).where(and(eq(aiAssistants.organisationId, orgId), inArray(aiAssistants.id, ids)));
        for (const a of as) names.set(a.id, { name: a.name, roleKey: a.type });
    }
    // A model reply's card lives on its chat message. Read through the session's organisation, so a
    // link can only ever resolve to this workspace's own conversation.
    const chatIds = [...new Set(rows.map((r) => Number((r.link as TeamLink | null)?.chatMessageId)).filter((x) => Number.isInteger(x) && x > 0))];
    const cards = new Map<number, unknown>();
    if (chatIds.length) {
        const cm = await db.select({ id: chatMessages.id, ui: chatMessages.uiElementJson })
            .from(chatMessages)
            .innerJoin(chatSessions, eq(chatSessions.id, chatMessages.chatSessionId))
            .where(and(inArray(chatMessages.id, chatIds), eq(chatSessions.organisationId, orgId)));
        for (const c of cm) if (c.ui) cards.set(c.id, c.ui);
    }
    return rows.map((r) => {
        const q = r.question as TeamQuestion | null;
        const chatMessageId = Number((r.link as TeamLink | null)?.chatMessageId);
        return {
            id: r.id, createdAt: r.createdAt.toISOString(), kind: r.kind, body: r.body,
            card: cards.get(chatMessageId) ?? null,
            campaignId: r.campaignId, campaignOrderId: r.campaignOrderId,
            from: r.fromAssistantId
                ? { kind: 'assistant', id: r.fromAssistantId, name: names.get(r.fromAssistantId)?.name ?? 'An assistant', roleKey: names.get(r.fromAssistantId)?.roleKey ?? null }
                : { kind: 'user', id: r.fromUserId, name: 'You', roleKey: null },
            to: r.toAssistantId ? { kind: 'assistant', id: r.toAssistantId, name: names.get(r.toAssistantId)?.name ?? null }
                : r.toUser ? { kind: 'user', id: null, name: 'You' } : { kind: 'none', id: null, name: null },
            link: (r.link as TeamLink | null) ?? null,
            question: q ? { ...q, answered: !!r.answeredAt, answer: r.answer } : null,
        };
    });
}

/** Messages addressed to the person that they have not seen yet. Open questions are not in it:
 *  they are counted by openQuestionCount, as needing the person, whether seen or not. */
export async function unreadCount(db: Db, orgId: number, userId: number): Promise<number> {
    const [read] = await db.select({ last: teamReads.lastReadId }).from(teamReads)
        .where(and(eq(teamReads.organisationId, orgId), eq(teamReads.userId, userId))).limit(1);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(teamMessages)
        .where(and(eq(teamMessages.organisationId, orgId), eq(teamMessages.toUser, true), gt(teamMessages.id, read?.last ?? 0), sql`NOT ${OPEN_QUESTION}`));
    return Number(n) || 0;
}

/** Questions to the person still waiting for an answer — part of the "needs you" count. */
export async function openQuestionCount(db: Db, orgId: number): Promise<number> {
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(teamMessages)
        .where(and(eq(teamMessages.organisationId, orgId), OPEN_QUESTION));
    return Number(n) || 0;
}

export async function markRead(db: Db, orgId: number, userId: number, upToId: number): Promise<void> {
    if (!Number.isInteger(upToId) || upToId <= 0) return;
    await db.insert(teamReads).values({ organisationId: orgId, userId, lastReadId: upToId })
        .onConflictDoUpdate({
            target: [teamReads.organisationId, teamReads.userId],
            set: { lastReadId: sql`GREATEST(${teamReads.lastReadId}, ${upToId})`, updatedAt: new Date() },
        });
}

/**
 * A person writes to an assistant. Stored word for word; the assistant's reply is written HERE,
 * honestly stating what the note will do, rather than by a model pretending to have read it.
 */
export async function sendFromUser(db: Db, args: {
    orgId: number; userId: number; assistantId: number; campaignId?: number | null; body: string;
    /** 'model': the page runs a chat turn for this note next (chat-orchestrator.ts `teamMessageId`),
     *  which writes the real reply — so no fixed one here. Anything else keeps the fixed reply. */
    reply?: 'model' | 'fixed';
}): Promise<{ ok: true; id: number } | { ok: false; status: number; error: string }> {
    const body = String(args.body || '').trim();
    if (!body) return { ok: false, status: 400, error: 'Write something first.' };
    if (body.length > MAX_MESSAGE_CHARS) return { ok: false, status: 400, error: `Keep it under ${MAX_MESSAGE_CHARS} characters — longer notes belong in the assistant's Rules.` };
    const [a] = await db.select({ id: aiAssistants.id, name: aiAssistants.name }).from(aiAssistants)
        .where(and(eq(aiAssistants.id, args.assistantId), eq(aiAssistants.organisationId, args.orgId))).limit(1);
    if (!a) return { ok: false, status: 404, error: 'That assistant is not in this workspace.' };
    let campaignId: number | null = null;
    if (args.campaignId) {
        const [c] = await db.select({ id: campaigns.id }).from(campaigns)
            .where(and(eq(campaigns.id, args.campaignId), eq(campaigns.organisationId, args.orgId))).limit(1);
        if (!c) return { ok: false, status: 404, error: 'That campaign is not in this workspace.' };
        campaignId = c.id;
    }
    const id = await postTeamMessage(db, { organisationId: args.orgId, campaignId, fromUserId: args.userId, toAssistantId: a.id, kind: 'message', body });
    if (!id) return { ok: false, status: 500, error: 'It could not be sent — please try again.' };
    // A campaign note reaches drafting through the campaign directive, which lives in the persisted
    // blueprint — recompile now so the very next draft reads it. Lazy: campaign-orders imports this.
    if (campaignId) {
        try {
            const { recompileAssistantForCampaign } = await import('./campaign-orders');
            await recompileAssistantForCampaign(a.id, 'team-note');
        } catch (err) {
            console.warn('[team-messages] recompile after a note failed — the next scheduled recompile picks it up', err instanceof Error ? err.message : err);
        }
    }
    if (args.reply === 'model') return { ok: true, id };
    // Asking for a call or a person gets the call-back form, never "Noted" (owner, 2026-10-19: a
    // "request a call back" here was answered with the Rules-tab reply). Same check as the chat.
    const wantsACall = asksForACall(body);
    await postTeamMessage(db, {
        organisationId: args.orgId, campaignId, fromAssistantId: a.id, toUser: true, kind: 'reply',
        body: wantsACall
            ? 'A person from the Be More Swan team can call you back. Leave your number with the button below and we will be in touch.'
            : campaignId
                ? 'Noted. I will follow this in everything I draft for this campaign from now on. To talk it through, open my chat.'
                : 'Noted — I will see this when we talk in chat. For a rule I follow in everything I draft, add it to my Do’s and don’ts card in Assistant Profile.',
        link: wantsACall
            ? { assistantId: a.id, callback: true, label: 'Request a call back' }
            : { assistantId: a.id, chat: true, label: 'Open chat' },
    });
    return { ok: true, id };
}

/**
 * The note a Team chat turn answers (chat-orchestrator.ts `teamMessageId`): this person's own
 * message to this assistant, in this workspace, not answered yet. Null otherwise — the turn is
 * refused rather than answering someone else's note, or the same note twice.
 */
export async function teamNoteForChatTurn(db: Db, args: { orgId: number; userId: number; assistantId: number; teamMessageId: number }): Promise<{ id: number; body: string; campaignId: number | null; campaignObjective: string | null } | null> {
    const [note] = await db.select({ id: teamMessages.id, body: teamMessages.body, campaignId: teamMessages.campaignId })
        .from(teamMessages)
        .where(and(
            eq(teamMessages.id, args.teamMessageId), eq(teamMessages.organisationId, args.orgId),
            eq(teamMessages.fromUserId, args.userId), eq(teamMessages.toAssistantId, args.assistantId),
            eq(teamMessages.kind, 'message'),
        ))
        .limit(1);
    if (!note) return null;
    const [answered] = await db.select({ id: teamMessages.id }).from(teamMessages)
        .where(and(eq(teamMessages.organisationId, args.orgId), eq(teamMessages.kind, 'reply'), gt(teamMessages.id, note.id),
            sql`(${teamMessages.link} ->> 'replyTo')::int = ${note.id}`))
        .limit(1);
    if (answered) return null;
    let campaignObjective: string | null = null;
    if (note.campaignId) {
        const [c] = await db.select({ objective: campaigns.objective }).from(campaigns)
            .where(and(eq(campaigns.id, note.campaignId), eq(campaigns.organisationId, args.orgId))).limit(1);
        campaignObjective = c?.objective ?? null;
    }
    return { ...note, campaignObjective };
}

/** Write a Team chat turn's reply under the note it answers. Never throws (postTeamMessage). */
export async function postTeamChatReply(db: Db, r: {
    orgId: number; assistantId: number; campaignId: number | null; replyTo: number; body: string;
    chatSessionId: number; chatMessageId: number;
}): Promise<number | null> {
    return postTeamMessage(db, {
        organisationId: r.orgId, campaignId: r.campaignId, fromAssistantId: r.assistantId, toUser: true, kind: 'reply',
        body: r.body,
        link: { assistantId: r.assistantId, chat: true, label: 'Open chat', chatSessionId: r.chatSessionId, chatMessageId: r.chatMessageId, replyTo: r.replyTo },
    });
}

/** Answer a question. Runs the question's own handler; says what happened in the thread. */
export async function answerQuestion(db: Db, args: { orgId: number; userId: number; messageId: number; value: string }): Promise<{ ok: true; said: string } | { ok: false; status: number; error: string }> {
    const [m] = await db.select().from(teamMessages)
        .where(and(eq(teamMessages.id, args.messageId), eq(teamMessages.organisationId, args.orgId))).limit(1);
    const q = m?.question as TeamQuestion | null;
    if (!m || !q) return { ok: false, status: 404, error: 'That question was not found.' };
    if (m.answeredAt) return { ok: false, status: 409, error: 'That question has already been answered.' };
    const choice = q.choices.find((c) => c.value === args.value);
    if (!choice) return { ok: false, status: 400, error: 'That is not one of the answers.' };

    // Claim it first, so two clicks (or two tabs) answer once.
    const claimed = await db.update(teamMessages)
        .set({ answer: choice.label, answeredAt: new Date(), answeredBy: args.userId })
        .where(and(eq(teamMessages.id, m.id), isNull(teamMessages.answeredAt)))
        .returning({ id: teamMessages.id });
    if (!claimed.length) return { ok: false, status: 409, error: 'That question has already been answered.' };

    let said: string;
    try {
        said = await QUESTION_HANDLERS[q.key](db, { orgId: args.orgId, ref: q.ref, value: args.value });
    } catch (err) {
        console.error('[team-messages] answer handler failed:', q.key, err instanceof Error ? err.message : err);
        await db.update(teamMessages).set({ answer: null, answeredAt: null, answeredBy: null }).where(eq(teamMessages.id, m.id));
        return { ok: false, status: 500, error: 'That did not work — please try again.' };
    }
    await postTeamMessage(db, {
        organisationId: args.orgId, campaignId: m.campaignId, campaignOrderId: m.campaignOrderId,
        fromAssistantId: m.fromAssistantId, toUser: true, kind: 'reply', body: said,
    });
    return { ok: true, said };
}

type Handler = (db: Db, a: { orgId: number; ref: number; value: string }) => Promise<string>;

const QUESTION_HANDLERS: Record<QuestionKey, Handler> = {
    // Release waiting work — the same release the Campaigns tab's "Start now" uses. Imported lazily:
    // the reconciler imports campaign-orders, which imports this module.
    start_now: async (db, a) => {
        if (a.value !== 'start') return 'Fine — I will wait, and start as soon as the earlier work is done.';
        const { BLOCKED_ORDER_FIELDS, releaseBlockedOrder, pokeDrainsFor } = await import('./campaign-reconciler');
        const [o] = await db.select({ ...BLOCKED_ORDER_FIELDS, status: campaignOrders.status }).from(campaignOrders)
            .where(and(eq(campaignOrders.id, a.ref), eq(campaignOrders.organisationId, a.orgId))).limit(1);
        if (!o || o.status !== 'blocked') return 'This has already started (or no longer exists), so there is nothing to change.';
        const started = await releaseBlockedOrder(db, o);
        if (started) await pokeDrainsFor([o.action], undefined, 'team-start-now');
        return started ? 'Starting now.' : 'I could not start it — the campaign may not be running. Check it on the Campaigns tab.';
    },
    // Add video to a picture brief: an ordinary brief edit, made before the next round is asked for.
    brief_video: async (db, a) => {
        if (a.value === 'none') return 'Pictures only, then.';
        const [b] = await db.select({ id: visualBriefs.id, sources: visualBriefs.sources, status: visualBriefs.status }).from(visualBriefs)
            .where(and(eq(visualBriefs.id, a.ref), eq(visualBriefs.organisationId, a.orgId))).limit(1);
        if (!b || b.status === 'cancelled') return 'That brief no longer exists, so nothing was changed.';
        const sources = [...new Set([...(Array.isArray(b.sources) ? (b.sources as string[]) : []), a.value])];
        await db.update(visualBriefs).set({ sources, updatedAt: new Date() }).where(eq(visualBriefs.id, b.id));
        return a.value === 'ai_video'
            ? 'Added AI video. The next round you ask for includes a clip, and its credit cost is shown before you ask.'
            : 'Added stock video. The next round you ask for includes video options, free.';
    },
};
