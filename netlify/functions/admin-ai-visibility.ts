// netlify/functions/admin-ai-visibility.ts
// Admin → Platform → AI Visibility: when a prospect asks an AI assistant for help, does Be More Swan
// come up, where, and is what it says true? The same questions, asked of each assistant, monthly.
//
//   GET                → { setUp, questions, runs (with headline numbers), trend, assistants,
//                          categories, facts }
//   GET ?runId=N       → { run, answers, summary }
//   POST { action: 'create_run', label, notes? }
//   POST { action: 'delete_run', id }
//   POST { action: 'save_answer', runId, questionId, assistant, mentioned, position?, link?,
//          accurate?, wrongFacts?, competitors?, notes?, answerText? }
//   POST { action: 'clear_answer', runId, questionId, assistant }
//   POST { action: 'save_question', id?, category, text, sortOrder? }
//   POST { action: 'set_question_active', id, isActive }
//   POST { action: 'fetch_answers', runId, assistants?: ['claude','chatgpt','gemini'], overwrite? }
//        → hands the run to ai-visibility-fetch-background (25 questions × 3 assistants with web
//          search is minutes, not the 26 s a request gets). The page polls GET ?runId for progress.
//   POST { action: 'score_answer', questionId, assistant, answerText }
//        → an answer pasted from an app, read the same way as an API answer (named? place? link?
//          competitors?) plus Claude's suggested accuracy. Nothing is saved; the form fills in.
//   POST { action: 'check_accuracy', runId }
//        → suggests accuracy, in the background, for every answer in the run that names us and has none.
//
// Until db/z-ai-visibility.sql is applied every read answers { setUp: false } and the page says so.
// Gated on `platform_config`, an existing permission, so no role data changes before it works.

import jwt from 'jsonwebtoken';
import { and, asc, eq, ne } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, aiVisibilityQuestions, aiVisibilityRuns, aiVisibilityAnswers, masterPlans } from '../../db/schema';
import { hasPermission } from '../../src/utils/rbac';
import { insertAdminAuditLog, getAdminIp } from '../../src/utils/admin-audit';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { TRIAL_DAYS } from '../../src/utils/trial';
import {
    ASSISTANTS, ASSISTANT_KEYS, AUTO_ASSISTANTS, CATEGORIES, CATEGORY_KEYS, LINK_VALUES, ACCURATE_VALUES,
    summarise, cleanCompetitors, detectMention, detectCompetitors, type AnswerRow, type AssistantKey,
} from '../../src/utils/ai-visibility';
import { suggestAccuracy } from '../../src/lib/ai-visibility-accuracy';
import { withLambda } from '@netlify/aws-lambda-compat';

const TEXT_MAX = 4000;
// The API key each automatic assistant needs on this site.
const AUTO_KEY: Record<string, string> = { claude: 'ANTHROPIC_API_KEY', chatgpt: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY' };
// A pasted answer's accuracy check runs inside this request (26 s cap), so it gets a fixed budget and
// the form is filled without a suggestion when it runs out.
const SCORE_ACCURACY_BUDGET_MS = 15_000;
const ANSWER_MAX = 20000;

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

async function requireAdmin(event: any): Promise<{ id: number } | null> {
    const secret = process.env.JWT_SECRET;
    if (!secret) return null;
    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return null;
    let userId: number;
    try { userId = (jwt.verify(match[1], secret) as { userId: number }).userId; } catch { return null; }
    const [row] = await getDb().select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
    return hasPermission(row?.role, 'platform_config') ? { id: userId } : null;
}

/** Postgres "relation does not exist" — the migration has not been applied on this database. */
function isMissingTable(err: unknown): boolean {
    const e = err as { code?: string; cause?: { code?: string } };
    return e?.code === '42P01' || e?.cause?.code === '42P01';
}

const clip = (v: unknown, max = TEXT_MAX): string | null => {
    const s = String(v ?? '').trim();
    return s ? s.slice(0, max) : null;
};

const toRow = (a: typeof aiVisibilityAnswers.$inferSelect): AnswerRow => ({
    questionId: a.questionId, assistant: a.assistant, mentioned: a.mentioned, position: a.position,
    link: a.link, accurate: a.accurate, competitors: a.competitors,
});

async function overview() {
    const db = getDb();
    const [questions, runs, answers] = await Promise.all([
        db.select().from(aiVisibilityQuestions).orderBy(asc(aiVisibilityQuestions.sortOrder), asc(aiVisibilityQuestions.id)),
        db.select().from(aiVisibilityRuns).orderBy(asc(aiVisibilityRuns.createdAt)),
        db.select().from(aiVisibilityAnswers),
    ]);
    // The facts an admin checks "Accurate?" against — prices from master data, never typed here.
    const plans = await db.select({ name: masterPlans.name, tierKey: masterPlans.tierKey, monthlyPriceGbp: masterPlans.monthlyPriceGbp, isContactSales: masterPlans.isContactSales })
        .from(masterPlans).where(and(eq(masterPlans.isActive, true), ne(masterPlans.tierKey, 'trial')))
        .orderBy(asc(masterPlans.monthlyPriceGbp));

    const trend = runs.map((r) => {
        const s = summarise(answers.filter((a) => a.runId === r.id).map(toRow), questions);
        return { runId: r.id, label: r.label, createdAt: r.createdAt, overall: s.overall, unprompted: s.unprompted };
    });
    return {
        setUp: true,
        questions,
        runs: runs.map((r) => ({ ...r, ...trend.find((t) => t.runId === r.id)!.overall })).reverse(),
        trend,
        assistants: ASSISTANTS.map((a) => ({ key: a.key, label: a.label, auto: a.auto })),
        categories: CATEGORIES,
        facts: { plans, trialDays: TRIAL_DAYS },
    };
}

async function runDetail(runId: number) {
    const db = getDb();
    const [run] = await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, runId)).limit(1);
    if (!run) return null;
    const [questions, answers] = await Promise.all([
        db.select({ id: aiVisibilityQuestions.id, category: aiVisibilityQuestions.category }).from(aiVisibilityQuestions),
        db.select().from(aiVisibilityAnswers).where(eq(aiVisibilityAnswers.runId, runId)),
    ]);
    return { setUp: true, run, answers, summary: summarise(answers.map(toRow), questions) };
}

/** Wake the background fetcher. Awaited (an un-awaited fetch can be frozen with the lambda); the
 *  -background invoke answers 202 as soon as Netlify accepts it. */
async function startFetch(event: any, payload: Record<string, unknown>): Promise<string | null> {
    const secret = process.env.CRON_TRIGGER_SECRET;
    const base = resolveBaseUrl(event.headers);
    if (!secret || !base) return !secret ? 'CRON_TRIGGER_SECRET is not set on this site.' : 'Could not work out this site\'s address.';
    try {
        const res = await fetch(`${base}/.netlify/functions/ai-visibility-fetch-background`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(8_000),
        });
        return res.status === 202 || res.ok ? null : `The fetcher refused to start (HTTP ${res.status}).`;
    } catch (err) {
        return `The fetcher could not be reached: ${err instanceof Error ? err.message : String(err)}`;
    }
}

export default withLambda(async (event) => {
    const admin = await requireAdmin(event);
    if (!admin) return json(403, { error: 'You need the platform_config permission for this page.' });
    const db = getDb();
    const headers = event.headers as Record<string, string | undefined>;
    const audit = (targetType: string, targetId: number | string | null, newState: Record<string, unknown>, previousState?: Record<string, unknown>) =>
        void insertAdminAuditLog({
            adminId: admin.id, action: 'ai_visibility_change', targetType, targetId: targetId ?? undefined,
            previousState, newState, ipAddress: getAdminIp(headers), userAgent: headers['user-agent'],
        });

    try {
        if (event.httpMethod === 'GET') {
            const runId = Number(event.queryStringParameters?.runId);
            if (runId) {
                const d = await runDetail(runId);
                return d ? json(200, d) : json(404, { error: 'No such run.' });
            }
            return json(200, await overview());
        }
        if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

        let body: any;
        try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }

        switch (body.action) {
            case 'create_run': {
                const label = clip(body.label, 80);
                if (!label) return json(400, { error: 'Give the run a name, e.g. "Nov 2026".' });
                const existing = await db.select({ id: aiVisibilityRuns.id }).from(aiVisibilityRuns).where(eq(aiVisibilityRuns.label, label)).limit(1);
                if (existing.length) return json(409, { error: `There is already a run called "${label}".` });
                const [run] = await db.insert(aiVisibilityRuns).values({ label, notes: clip(body.notes), createdBy: admin.id }).returning();
                audit('ai_visibility_run', run.id, { label });
                return json(201, { run });
            }
            case 'delete_run': {
                const id = Number(body.id);
                const [run] = await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, id)).limit(1);
                if (!run) return json(404, { error: 'No such run.' });
                await db.delete(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, id));
                audit('ai_visibility_run', id, { deleted: true }, { label: run.label });
                return json(200, { ok: true });
            }
            case 'save_answer': {
                const runId = Number(body.runId), questionId = Number(body.questionId);
                const assistant = String(body.assistant || '');
                if (!runId || !questionId || !ASSISTANT_KEYS.includes(assistant)) return json(400, { error: 'runId, questionId and a known assistant are required.' });
                if (body.mentioned !== true && body.mentioned !== false) return json(400, { error: 'Say whether Be More Swan was mentioned.' });
                const position = body.position == null || body.position === '' ? null : Number(body.position);
                if (position !== null && !(Number.isInteger(position) && position >= 1 && position <= 50)) return json(400, { error: 'Position is a number from 1 to 50.' });
                const link = body.link ? String(body.link) : null;
                if (link && !(LINK_VALUES as readonly string[]).includes(link)) return json(400, { error: 'Unknown link value.' });
                const accurate = body.accurate ? String(body.accurate) : null;
                if (accurate && !(ACCURATE_VALUES as readonly string[]).includes(accurate)) return json(400, { error: 'Unknown accuracy value.' });
                // A suggestion made for a pasted answer (score_answer) travels with the save.
                const suggested = body.suggestedAccurate ? String(body.suggestedAccurate) : undefined;
                if (suggested && !(ACCURATE_VALUES as readonly string[]).includes(suggested)) return json(400, { error: 'Unknown suggested accuracy value.' });

                const [existing] = await db.select().from(aiVisibilityAnswers).where(and(
                    eq(aiVisibilityAnswers.runId, runId), eq(aiVisibilityAnswers.questionId, questionId), eq(aiVisibilityAnswers.assistant, assistant))).limit(1);
                const values = {
                    mentioned: body.mentioned as boolean,
                    // Not mentioned → nothing to rank, link or check. Keeps the summary honest when a
                    // cell is flipped from yes to no.
                    position: body.mentioned ? position : null,
                    link: body.mentioned ? link : null,
                    accurate: body.mentioned ? accurate : null,
                    wrongFacts: body.mentioned ? clip(body.wrongFacts) : null,
                    competitors: cleanCompetitors(body.competitors),
                    notes: clip(body.notes),
                    // An API answer keeps its fetched text unless the admin pastes a replacement.
                    answerText: body.answerText !== undefined ? clip(body.answerText, ANSWER_MAX) : existing?.answerText ?? null,
                    ...(suggested ? { suggestedAccurate: suggested, suggestedWrongFacts: clip(body.suggestedWrongFacts), suggestedAt: new Date() } : {}),
                    answeredBy: admin.id,
                    answeredAt: new Date(),
                };
                const [row] = existing
                    ? await db.update(aiVisibilityAnswers).set({ ...values, error: null }).where(eq(aiVisibilityAnswers.id, existing.id)).returning()
                    : await db.insert(aiVisibilityAnswers).values({ runId, questionId, assistant, source: 'manual', ...values }).returning();
                return json(200, { answer: row });
            }
            case 'clear_answer': {
                const runId = Number(body.runId), questionId = Number(body.questionId);
                await db.delete(aiVisibilityAnswers).where(and(
                    eq(aiVisibilityAnswers.runId, runId), eq(aiVisibilityAnswers.questionId, questionId), eq(aiVisibilityAnswers.assistant, String(body.assistant || ''))));
                return json(200, { ok: true });
            }
            case 'save_question': {
                const text = clip(body.text, 500);
                const category = String(body.category || '');
                if (!text || text.length < 5) return json(400, { error: 'Write the question as a prospect would ask it.' });
                if (!CATEGORY_KEYS.includes(category)) return json(400, { error: 'Pick a question type.' });
                const sortOrder = Number.isInteger(Number(body.sortOrder)) ? Number(body.sortOrder) : 0;
                const id = Number(body.id) || null;
                const clash = await db.select({ id: aiVisibilityQuestions.id }).from(aiVisibilityQuestions).where(eq(aiVisibilityQuestions.text, text)).limit(1);
                if (clash.length && clash[0].id !== id) return json(409, { error: 'That question is already on the list.' });
                if (id) {
                    const [prev] = await db.select().from(aiVisibilityQuestions).where(eq(aiVisibilityQuestions.id, id)).limit(1);
                    if (!prev) return json(404, { error: 'No such question.' });
                    const [row] = await db.update(aiVisibilityQuestions).set({ text, category, sortOrder, updatedAt: new Date() }).where(eq(aiVisibilityQuestions.id, id)).returning();
                    audit('ai_visibility_question', id, { text, category, sortOrder }, { text: prev.text, category: prev.category, sortOrder: prev.sortOrder });
                    return json(200, { question: row });
                }
                const [row] = await db.insert(aiVisibilityQuestions).values({ text, category, sortOrder, createdBy: admin.id }).returning();
                audit('ai_visibility_question', row.id, { text, category, sortOrder });
                return json(201, { question: row });
            }
            case 'set_question_active': {
                const id = Number(body.id);
                const [row] = await db.update(aiVisibilityQuestions).set({ isActive: !!body.isActive, updatedAt: new Date() }).where(eq(aiVisibilityQuestions.id, id)).returning();
                if (!row) return json(404, { error: 'No such question.' });
                audit('ai_visibility_question', id, { isActive: row.isActive });
                return json(200, { question: row });
            }
            case 'fetch_answers': {
                const runId = Number(body.runId);
                const [run] = await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, runId)).limit(1);
                if (!run) return json(404, { error: 'No such run.' });
                const wanted = Array.isArray(body.assistants) ? body.assistants.map(String) : AUTO_ASSISTANTS;
                // An assistant whose key is missing on this site is skipped rather than failing the
                // whole fetch; the reply says which, so the page can tell the admin.
                const requested = AUTO_ASSISTANTS.filter((a) => wanted.includes(a));
                if (!requested.length) return json(400, { error: 'Only Claude, ChatGPT and Gemini answers can be fetched automatically.' });
                const skipped = requested.filter((a) => !process.env[AUTO_KEY[a]]);
                const assistants = requested.filter((a) => !skipped.includes(a));
                if (!assistants.length) return json(400, { error: `No API key is set on this site for ${skipped.map((a) => AUTO_KEY[a]).join(', ')}.` });
                const active = await db.select({ id: aiVisibilityQuestions.id }).from(aiVisibilityQuestions).where(eq(aiVisibilityQuestions.isActive, true));
                const problem = await startFetch(event, { runId, assistants, overwrite: !!body.overwrite, adminId: admin.id });
                if (problem) return json(502, { error: problem });
                audit('ai_visibility_run', runId, { fetch: assistants, overwrite: !!body.overwrite });
                return json(202, { queued: active.length * assistants.length, assistants, skipped: skipped.map((a) => ({ assistant: a, envVar: AUTO_KEY[a] })) });
            }
            case 'score_answer': {
                const answerText = clip(body.answerText, ANSWER_MAX);
                const assistant = String(body.assistant || '');
                if (!answerText) return json(400, { error: 'Paste the answer first.' });
                if (!ASSISTANT_KEYS.includes(assistant)) return json(400, { error: 'Unknown assistant.' });
                const [q] = await db.select({ text: aiVisibilityQuestions.text }).from(aiVisibilityQuestions).where(eq(aiVisibilityQuestions.id, Number(body.questionId))).limit(1);
                if (!q) return json(404, { error: 'No such question.' });
                // A pasted answer carries no source list, so "linked" is read from links in the text.
                const m = detectMention(answerText, []);
                const suggestion = m.mentioned ? await suggestAccuracy(q.text, answerText, SCORE_ACCURACY_BUDGET_MS) : null;
                return json(200, { ...m, competitors: detectCompetitors(answerText, assistant as AssistantKey), suggestion });
            }
            case 'check_accuracy': {
                const runId = Number(body.runId);
                const [run] = await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, runId)).limit(1);
                if (!run) return json(404, { error: 'No such run.' });
                if (!process.env.ANTHROPIC_API_KEY) return json(400, { error: 'ANTHROPIC_API_KEY is not set on this site.' });
                const problem = await startFetch(event, { runId, mode: 'accuracy' });
                if (problem) return json(502, { error: problem });
                return json(202, { ok: true });
            }
            default:
                return json(400, { error: 'Unknown action.' });
        }
    } catch (err) {
        if (isMissingTable(err)) return json(200, { setUp: false });
        console.error('[admin-ai-visibility]', err);
        return json(500, { error: err instanceof Error ? err.message : 'Something went wrong.' });
    }
});

// Exported for tests.
export { isMissingTable };
