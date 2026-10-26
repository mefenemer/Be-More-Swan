// src/utils/mentor-jobs.ts
// The Business Mentor's background work (docs/business-mentor-plan.md §4.5, §2.1, §3.11), over the
// mentor_jobs table (db/z-business-mentor-phase-2.sql):
//
//   research        — "Look this up": a grounded web search (gatewayGenerateGrounded). Only URLs the
//                     search tool itself returned are kept (matchesSearchedUrl, the rule
//                     compliance-verification.ts enforces); no search, or nothing found → it says so and
//                     never fills the gap from memory.
//   strategy_draft  — "Draft it for me": the Mentor drafts one strategy document from the workspace. The
//                     result is a PROPOSAL: nothing is saved until the user presses "Use this draft".
//
// Why a background job: a grounded search was measured at ~124 s and a chat turn is cut at 26 s (§1.1
// point 5). Queued from mentor.ts (the Plan tab's buttons AND the chat cards — one server action), run by
// netlify/functions/mentor-job-background.ts, posted back into the chat it was asked from, with a
// notification. Each spends 1 task when it DELIVERS (owner decision §2.1); a failure is free.
//
// Both run on the Mentor's model from Admin ▸ Assistants ▸ Model & rules (withRoleModel), code default
// Opus 5.5 (§2.4), registered in ROLE_MODEL_PATHS. Background work isn't held to Low thinking.
//
// ⚠️ Tolerates the table being missing: queueing refuses with a plain message, lists read as empty.

import Anthropic from '@anthropic-ai/sdk';
import { and, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import { aiAssistants, chatMessages, chatSessions, mentorJobs, organisations } from '../../db/schema';
import { gatewayGenerateGrounded } from '../lib/ai-gateway';
import { adaptForModel, replyText } from '../config/model-options';
import { MENTOR_RESEARCH_CRAFT, MENTOR_STRATEGY_CRAFT } from '../constants/mentor-craft';
import { playbookFor, renderPlaybookForMentor } from '../config/mentor-playbooks';
import { loadRoleModel, withRoleModel } from './assistant-model';
import { matchesSearchedUrl } from './compliance-verification';
import { findMentor, MENTOR_ROLE_KEY } from './mentor-provision';
import { buildMentorSnapshotParts } from './mentor-snapshot';
import { parseModelJson } from './model-json';
import { STRATEGY_KINDS, cleanStrategyPatch, isStrategyKind, loadStrategyDocs, pickVersions, type StrategyKind } from './strategy-documents';
import { buildStrategyCard, cleanQuestion } from './mentor-plan-cards';
export { cleanQuestion, QUESTION_MAX, QUESTION_MIN } from './mentor-plan-cards';
import { getTaskUsage, recordCompletedWork, TASK_LIMIT_MESSAGE } from './work-metering';
import { createNotification } from './notify';
import { logAiUsage } from './ai-usage';
import { sanitizeForModel } from './text-safe';
import { isGlobalAiDisabled } from './platform-config';
import { resolveBaseUrl } from './base-url';
import { recordPlatformIncident } from './platform-incident';

type Db = any;

export const MENTOR_JOB_KINDS = ['research', 'strategy_draft'] as const;
export type MentorJobKind = typeof MENTOR_JOB_KINDS[number];
/** The code default for the Mentor's background jobs (§2.4, §3.11) — the same as its chat's row. */
export const MENTOR_JOB_DEFAULT_MODEL = 'claude-opus-5-5';
/** Queued or running at once per workspace: enough for a busy session, not a runaway loop. */
export const MAX_OPEN_JOBS = 3;
/** A job still "running" after this never reached or never finished its worker: it is ended, free. */
export const STALE_AFTER_MS = 20 * 60_000;
export interface ResearchResult {
    outcome: 'answered' | 'nothing_found' | 'no_search';
    answer: string;
    sources: Array<{ url: string; title: string }>;
    searchCount: number;
}

export interface MentorJobView {
    id: number;
    kind: MentorJobKind;
    status: 'queued' | 'running' | 'done' | 'failed';
    question: string | null;
    strategyKind: StrategyKind | null;
    result: Record<string, unknown> | null;
    error: string | null;
    createdAt: string | null;
    finishedAt: string | null;
}

const missing = (err: any) => {
    const code = err?.code ?? err?.cause?.code;
    return code === '42P01' || code === '42703';
};

const NOT_READY = 'Research and drafting aren’t switched on for this workspace yet — please try again later.';

/**
 * Pure: the research answer, held to what the search found. Sources the search tool didn't return are
 * dropped; with no search, or no source left, the answer is replaced by a plain "I couldn't find it" —
 * the model's unsourced words are never passed on.
 */
export function parseResearchReply(text: string, searchedUrls: string[], searchCount: number): ResearchResult {
    if (searchCount === 0) {
        return { outcome: 'no_search', searchCount, sources: [], answer: 'No search ran this time, so I have no sourced answer to give you — and I won’t guess. Nothing was charged. Try asking again in a few minutes.' };
    }
    const parsed = parseModelJson<{ answer?: unknown; sources?: unknown }>(text)
        // A grounded reply is several text blocks joined by newlines, which can split a JSON string.
        ?? parseModelJson<{ answer?: unknown; sources?: unknown }>(text.replace(/\n/g, ' '));
    const list = Array.isArray(parsed?.sources) ? parsed!.sources : [];
    const seen = new Set<string>();
    const sources = list.flatMap((s) => {
        const o = s && typeof s === 'object' ? s as Record<string, unknown> : {};
        const url = typeof o.url === 'string' ? matchesSearchedUrl(o.url.trim(), searchedUrls) : null;
        if (!url || seen.has(url)) return [];
        seen.add(url);
        const title = typeof o.title === 'string' && o.title.trim() ? o.title.trim().slice(0, 200) : new URL(url).host;
        return [{ url, title }];
    }).slice(0, 6);
    // Any URL written into the answer itself must also be one the search found.
    const answer = (typeof parsed?.answer === 'string' ? parsed.answer : '')
        .replace(/https?:\/\/[^\s)\]]+/g, (u) => (matchesSearchedUrl(u, searchedUrls) ? u : '[link removed]'))
        .trim().slice(0, 2000);
    if (!sources.length || !answer) {
        return { outcome: 'nothing_found', searchCount, sources: [], answer: `I searched${searchCount > 1 ? ` ${searchCount} times` : ''} but found no source I can show you for that, so I won’t guess. Try asking it a different way.` };
    }
    return { outcome: 'answered', answer, sources, searchCount };
}

/** Pure: how a job reads on the page and in the chat card. */
export function toJobView(r: any): MentorJobView {
    const input = (r.input && typeof r.input === 'object') ? r.input as Record<string, unknown> : {};
    return {
        id: r.id, kind: r.kind, status: r.status,
        question: typeof input.question === 'string' ? input.question : null,
        strategyKind: isStrategyKind(input.kind) ? input.kind : null,
        result: (r.result && typeof r.result === 'object') ? r.result : null,
        error: r.error ?? null,
        createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
        finishedAt: r.finishedAt ? new Date(r.finishedAt).toISOString() : null,
    };
}

/** End jobs whose worker never came back (free: nothing is charged for a job that didn't deliver). */
async function sweepStale(db: Db, orgId: number): Promise<void> {
    await db.update(mentorJobs).set({ status: 'failed', error: 'This took too long and was stopped. Nothing was charged — please try again.', finishedAt: new Date() })
        .where(and(eq(mentorJobs.organisationId, orgId), inArray(mentorJobs.status, ['queued', 'running']), lt(mentorJobs.createdAt, new Date(Date.now() - STALE_AFTER_MS))));
}

/** The workspace's recent jobs of one kind, newest first; null when the table isn't there yet. */
export async function loadMentorJobs(db: Db, orgId: number, kind: MentorJobKind, limit = 20): Promise<MentorJobView[] | null> {
    try {
        await sweepStale(db, orgId);
        const rows = await db.select().from(mentorJobs)
            .where(and(eq(mentorJobs.organisationId, orgId), eq(mentorJobs.kind, kind)))
            .orderBy(desc(mentorJobs.createdAt)).limit(limit);
        return rows.map(toJobView);
    } catch (err) {
        if (missing(err)) return null;
        throw err;
    }
}

export async function loadMentorJob(db: Db, orgId: number, id: number): Promise<MentorJobView | null> {
    try {
        await sweepStale(db, orgId);
        const [r] = await db.select().from(mentorJobs).where(and(eq(mentorJobs.id, id), eq(mentorJobs.organisationId, orgId))).limit(1);
        return r ? toJobView(r) : null;
    } catch (err) {
        if (missing(err)) return null;
        throw err;
    }
}

export type QueueResult = { ok: true; job: MentorJobView } | { ok: false; status: number; error: string; code?: string };

/**
 * Queue one job: the Plan tab's "Look this up" / "Draft it for me" and the chat's cards both call this
 * (mentor.ts). Refused with no paid plan (§2.7) or at the task cap. The chat session is kept only when it
 * is this user's chat with this workspace's Mentor.
 */
export async function queueMentorJob(db: Db, args: {
    orgId: number; userId: number; kind: MentorJobKind; question?: unknown; strategyKind?: unknown; chatSessionId?: unknown;
}): Promise<QueueResult> {
    let input: Record<string, unknown>;
    if (args.kind === 'research') {
        const q = cleanQuestion(args.question);
        if (!q.ok) return { ok: false, status: 400, error: q.error };
        input = { question: q.text };
    } else {
        if (!isStrategyKind(args.strategyKind)) return { ok: false, status: 400, error: 'Which document?' };
        input = { kind: args.strategyKind };
    }
    if (await isGlobalAiDisabled()) return { ok: false, status: 503, error: 'AI services are temporarily unavailable. Please try again later.' };
    const mentor = await findMentor(db, args.orgId);
    if (!mentor) return { ok: false, status: 404, error: 'This workspace has no Business Mentor yet.' };

    try {
        const usage = await getTaskUsage(db, args.orgId);
        if (!usage.hasPlan) return { ok: false, status: 403, code: 'UPGRADE_REQUIRED', error: 'Research and drafting need a paid plan. You can still ask your Mentor questions about Be More Swan.' };
        if (usage.remaining !== null && usage.remaining < 1) return { ok: false, status: 403, code: 'TASK_LIMIT', error: TASK_LIMIT_MESSAGE };
    } catch (err) {
        // Fail open, like every other background work (work-metering.ts).
        console.error('[mentor-jobs] task check failed — allowing the job', err instanceof Error ? err.message : err);
    }

    let chatSessionId: number | null = null;
    const sid = Number(args.chatSessionId);
    if (Number.isInteger(sid) && sid > 0) {
        const [s] = await db.select({ id: chatSessions.id }).from(chatSessions).where(and(
            eq(chatSessions.id, sid), eq(chatSessions.organisationId, args.orgId), eq(chatSessions.userId, args.userId), eq(chatSessions.aiAssistantId, mentor.id),
        )).limit(1);
        chatSessionId = s?.id ?? null;
    }

    let row: any;
    try {
        await sweepStale(db, args.orgId);
        const [{ open }] = await db.select({ open: sql<number>`count(*)::int` }).from(mentorJobs)
            .where(and(eq(mentorJobs.organisationId, args.orgId), inArray(mentorJobs.status, ['queued', 'running']), gt(mentorJobs.createdAt, new Date(Date.now() - STALE_AFTER_MS))));
        if (Number(open) >= MAX_OPEN_JOBS) return { ok: false, status: 429, error: `Your Mentor is already working on ${MAX_OPEN_JOBS} things — wait for one to finish, then try again.` };
        [row] = await db.insert(mentorJobs).values({
            organisationId: args.orgId, aiAssistantId: mentor.id, userId: args.userId, kind: args.kind, input, chatSessionId,
        }).returning();
    } catch (err) {
        if (missing(err)) return { ok: false, status: 503, error: NOT_READY };
        throw err;
    }

    if (!(await triggerMentorJob(row.id))) {
        await db.update(mentorJobs).set({ status: 'failed', error: 'It couldn’t be started just now. Nothing was charged — please try again.', finishedAt: new Date() }).where(eq(mentorJobs.id, row.id));
        return { ok: false, status: 503, error: 'Your Mentor couldn’t start that just now. Nothing was charged — please try again.' };
    }
    return { ok: true, job: toJobView(row) };
}

/**
 * Wake the worker. ⚠️ Awaited: an un-awaited fetch can freeze with the lambda before it leaves (same
 * rule as trigger-site-audit.ts). A `-background` function answers 202 at once. Never throws.
 */
export async function triggerMentorJob(jobId: number): Promise<boolean> {
    const secret = process.env.CRON_TRIGGER_SECRET;
    const baseUrl = resolveBaseUrl();
    if (!secret || !baseUrl) {
        console.error('[mentor-jobs] NOT dispatched — ' + (!secret ? 'CRON_TRIGGER_SECRET unset' : 'base URL unresolved'), { jobId });
        return false;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
        const res = await fetch(`${baseUrl}/.netlify/functions/mentor-job-background`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
            body: JSON.stringify({ jobId }),
            signal: controller.signal,
        });
        if (res.status !== 202 && !res.ok) {
            console.error('[mentor-jobs] worker refused the dispatch', { jobId, status: res.status });
            return false;
        }
        return true;
    } catch (err) {
        console.error('[mentor-jobs] dispatch failed', { jobId, err: err instanceof Error ? err.message : err });
        return false;
    } finally {
        clearTimeout(timer);
    }
}

// ── The worker's side ────────────────────────────────────────────────────────────────────────────

async function businessLine(db: Db, orgId: number): Promise<string> {
    const [org] = await db.select({ name: organisations.name, industry: organisations.industry, description: organisations.businessDescription })
        .from(organisations).where(eq(organisations.id, orgId)).limit(1);
    const bits = [org?.name, org?.industry, (org?.description ?? '').slice(0, 400)].filter((x) => x && String(x).trim());
    return bits.length ? bits.join(' — ') : 'A small business (no details filled in yet).';
}

async function runResearch(db: Db, job: any): Promise<{ result: ResearchResult; charge: boolean }> {
    const question = String(job.input?.question ?? '');
    const system = `${MENTOR_RESEARCH_CRAFT}\n\nTHE BUSINESS (for context only — the question is about the world, not about their own records): ${await businessLine(db, job.organisationId)}\nAssume the UK unless the question says otherwise.`;
    const gw = await withRoleModel(
        await loadRoleModel(db, MENTOR_ROLE_KEY), MENTOR_JOB_DEFAULT_MODEL,
        (m, thinking) => gatewayGenerateGrounded({
            system, messages: [{ role: 'user', content: `Question: ${question}` }], maxTokens: 1500, model: m, thinking,
            usage: { workspaceId: job.organisationId, userId: job.userId, assistantId: job.aiAssistantId, sessionId: `mentor:research:${job.id}`, dataCategories: ['business_context'] },
        }),
        { label: 'mentor research' },
    );
    const result = parseResearchReply(gw.text, gw.searchedUrls, gw.searchCount);
    // A search was paid for whenever one ran; with none, nothing was delivered.
    return { result, charge: gw.searchCount > 0 };
}

/** Pure: the drafting prompt's document part — keys, labels, hints and limits, and the current text. */
export function strategyDraftBrief(kind: StrategyKind, current: { sections: Record<string, string>; assumptions?: Array<{ assumption: string; test: string }> } | null, ideaCheck: string | null): string {
    const def = STRATEGY_KINDS[kind];
    const lines = [`THE DOCUMENT TO DRAFT: ${def.label}. Its sections (key — what goes in it — at most N characters):`];
    for (const s of def.sections) lines.push(`- ${s.key} — ${s.label}: ${s.hint} (${s.max})`);
    if (current && Object.values(current.sections).some((v) => v?.trim())) {
        lines.push('', 'WHAT IS WRITTEN NOW (keep what is right; the owner may have written it):');
        for (const s of def.sections) if (current.sections[s.key]?.trim()) lines.push(`- ${s.key}: ${current.sections[s.key].trim()}`);
        if (current.assumptions?.length) lines.push(`- assumptions: ${current.assumptions.map((a) => `${a.assumption} → ${a.test}`).join(' | ')}`);
    }
    if (ideaCheck) lines.push('', 'THEIR IDEA CHECK (build from it):', ideaCheck);
    lines.push('', `Return STRICT JSON only: {"sections": {${def.sections.map((s) => `"${s.key}": "..."`).join(', ')}}${def.hasAssumptions ? ', "assumptions": [{"assumption": "...", "test": "<a cheap test this month>"}]' : ''}}`);
    return lines.join('\n');
}

async function runStrategyDraft(db: Db, job: any): Promise<{ result: Record<string, unknown>; charge: boolean }> {
    const kind = job.input?.kind as StrategyKind;
    if (!isStrategyKind(kind)) throw new Error('unknown document kind');
    const [parts, docs] = await Promise.all([
        buildMentorSnapshotParts(db, job.organisationId, job.userId),
        loadStrategyDocs(db, job.organisationId),
    ]);
    const all = docs ?? [];
    const { draft, approved } = pickVersions(all, kind);
    const idea = kind === 'idea_check' ? null : pickVersions(all, 'idea_check');
    const ideaDoc = idea ? (idea.approved ?? idea.draft) : null;
    const ideaText = ideaDoc ? STRATEGY_KINDS.idea_check.sections.filter((s) => ideaDoc.body.sections[s.key]?.trim()).map((s) => `- ${s.label} ${ideaDoc.body.sections[s.key].trim()}`).join('\n') || null : null;
    const playbook = renderPlaybookForMentor(playbookFor(parts.data.offerKinds)).join('\n');
    const system = [MENTOR_STRATEGY_CRAFT, parts.text, playbook, strategyDraftBrief(kind, (draft ?? approved)?.body ?? null, ideaText)].join('\n\n');

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const { response, model } = await withRoleModel(
        await loadRoleModel(db, MENTOR_ROLE_KEY), MENTOR_JOB_DEFAULT_MODEL,
        async (m, thinking) => ({ model: m, response: await anthropic.messages.create(adaptForModel({
            model: m, max_tokens: 4000, system: sanitizeForModel(system),
            messages: sanitizeForModel([{ role: 'user' as const, content: `Draft the ${STRATEGY_KINDS[kind].label.toLowerCase()} now.` }]),
        }, m, thinking) as Anthropic.MessageCreateParamsNonStreaming, { timeout: 240_000 }) }),
        { label: 'mentor strategy draft' },
    );
    void logAiUsage({
        workspaceId: job.organisationId, userId: job.userId, assistantId: job.aiAssistantId, model,
        inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens,
        sessionId: `mentor:strategy:${job.id}`, dataCategories: ['business_context'],
    });
    const parsed = parseModelJson<{ sections?: unknown; assumptions?: unknown }>(replyText(response.content));
    const patch = parsed ? cleanStrategyPatch(kind, parsed) : null;
    if (!patch || !Object.values(patch.sections).some((v) => v)) throw new Error('The draft came back empty.');
    return { result: { kind, ...patch }, charge: true };
}

/** Post the outcome into the chat it was asked from (this user's chat with the Mentor). Never throws. */
async function postToChat(db: Db, job: any, content: string, uiElement: unknown): Promise<void> {
    if (!job.chatSessionId) return;
    try {
        const [s] = await db.select({ id: chatSessions.id }).from(chatSessions)
            .where(and(eq(chatSessions.id, job.chatSessionId), eq(chatSessions.organisationId, job.organisationId))).limit(1);
        if (!s) return;
        await db.insert(chatMessages).values({ chatSessionId: s.id, role: 'assistant', content, uiElementJson: uiElement ?? null });
        await db.update(chatSessions).set({ updatedAt: new Date() }).where(eq(chatSessions.id, s.id));
    } catch (err) {
        console.error('[mentor-jobs] could not post into the chat (non-fatal)', err instanceof Error ? err.message : err);
    }
}

/** Pure: a question short enough for a notification, cut at a word. */
export function shortQuestion(q: string, max = 110): string {
    const t = q.replace(/\s+/g, ' ').trim();
    if (t.length <= max) return t;
    const cut = t.slice(0, max);
    return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 20)).replace(/[\s,;:(–-]+$/, '')}…`;
}

/** Pure: the chat message for a research result — the answer, then its links. */
export function researchMessage(question: string, r: ResearchResult): string {
    const head = `You asked me to look up: “${question}”`;
    if (r.outcome !== 'answered') return `${head}\n\n${r.answer}`;
    return `${head}\n\n${r.answer}\n\nSources:\n${r.sources.map((s) => `- [${s.title.replace(/[[\]]/g, '')}](${s.url})`).join('\n')}\n\nIt’s also in the Research list on my Plan tab.`;
}

/** Run one job to the end. Called by mentor-job-background.ts. Never throws; always ends the job. */
export async function runMentorJob(db: Db, jobId: number): Promise<void> {
    let job: any;
    try {
        [job] = await db.update(mentorJobs).set({ status: 'running', startedAt: new Date() })
            .where(and(eq(mentorJobs.id, jobId), eq(mentorJobs.status, 'queued'))).returning();
    } catch (err) {
        console.error('[mentor-jobs] could not claim job', jobId, err);
        return;
    }
    if (!job) return; // already claimed, finished or swept
    const [mentor] = await db.select({ id: aiAssistants.id, name: aiAssistants.name }).from(aiAssistants)
        .where(and(eq(aiAssistants.id, job.aiAssistantId ?? 0), eq(aiAssistants.organisationId, job.organisationId))).limit(1).catch(() => []);
    const name = mentor?.name || 'Your Mentor';

    try {
        if (job.kind === 'research') {
            const { result, charge } = await runResearch(db, job);
            await db.update(mentorJobs).set({ status: 'done', result, finishedAt: new Date() }).where(eq(mentorJobs.id, job.id));
            if (charge) await recordCompletedWork(db, job.organisationId, 'mentor_research', { assistantId: job.aiAssistantId, ref: `mentor_job:${job.id}` });
            await postToChat(db, job, researchMessage(String(job.input?.question ?? ''), result), null);
            if (job.userId) {
                await createNotification(db, 'mentor_research_ready', {
                    userId: job.userId, assistantId: job.aiAssistantId, category: 'state_change',
                    context: { assistant: { name }, research: { question: shortQuestion(String(job.input?.question ?? '')), where: job.chatSessionId ? 'in your chat and on the Plan tab' : 'on the Plan tab' } },
                    metadata: { assistantId: job.aiAssistantId, mentorJobId: job.id },
                });
            }
        } else {
            const { result, charge } = await runStrategyDraft(db, job);
            await db.update(mentorJobs).set({ status: 'done', result, finishedAt: new Date() }).where(eq(mentorJobs.id, job.id));
            if (charge) await recordCompletedWork(db, job.organisationId, 'mentor_strategy', { assistantId: job.aiAssistantId, ref: `mentor_job:${job.id}` });
            const kind = result.kind as StrategyKind;
            const docs = await loadStrategyDocs(db, job.organisationId).catch(() => null);
            const card = buildStrategyCard({ op: 'revise', kind, sections: result.sections as Record<string, string>, assumptions: result.assumptions as any, asked: true, why: 'You asked me to draft it.', summary: `My draft of your ${STRATEGY_KINDS[kind].label.toLowerCase()}` }, docs ?? []);
            await postToChat(db, job, `I’ve drafted your ${STRATEGY_KINDS[kind].label.toLowerCase()}. Have a look and correct anything I’ve got wrong — nothing is saved until you choose “Use this draft”, here or on my Plan tab.`, 'error' in card ? null : { ...card, jobId: job.id });
            if (job.userId) {
                await createNotification(db, 'mentor_draft_ready', {
                    userId: job.userId, assistantId: job.aiAssistantId, category: 'state_change',
                    context: { assistant: { name }, document: { name: STRATEGY_KINDS[kind].label.toLowerCase() } },
                    metadata: { assistantId: job.aiAssistantId, mentorJobId: job.id },
                });
            }
        }
    } catch (err) {
        console.error('[mentor-jobs] job failed', { jobId, kind: job.kind, message: err instanceof Error ? err.message : String(err) });
        await recordPlatformIncident(db, { kind: 'mentor_job', error: err, organisationId: job.organisationId, assistantId: job.aiAssistantId, role: 'business_mentor', ids: { mentorJobId: job.id, jobKind: job.kind }, view: 'mentor-job-background' });
        const error = 'Your Mentor couldn’t finish this time. Nothing was charged — please try again in a few minutes.';
        await db.update(mentorJobs).set({ status: 'failed', error, finishedAt: new Date() }).where(eq(mentorJobs.id, job.id)).catch(() => {});
        await postToChat(db, job, job.kind === 'research'
            ? `I couldn’t finish looking up “${String(job.input?.question ?? '')}”. Nothing was charged — ask me again in a few minutes.`
            : 'I couldn’t finish that draft. Nothing was charged — ask me again in a few minutes.', null);
    }
}
