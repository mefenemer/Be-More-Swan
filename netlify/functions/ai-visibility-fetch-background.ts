// netlify/functions/ai-visibility-fetch-background.ts
// Admin → AI Visibility → "Fetch answers": ask every active question of Claude and ChatGPT through
// their APIs, with web search on, and record what comes back.
//
// Started by admin-ai-visibility.ts (Bearer CRON_TRIGGER_SECRET, like the other internal
// `-background` triggers). A background function has 15 minutes; 25 questions × 2 assistants, three
// at a time, with each searching the web, takes a few. The page polls the run for progress.
//
// ── What an "API answer" is, and is not ──────────────────────────────────────────────────────────
// Same model family and the same web search the consumer apps use, asked from the UK with no account,
// memory or chat history. It is NOT a screenshot of chatgpt.com: the consumer app adds its own system
// prompt, personalisation and model routing. So these rows are source = 'api' and labelled as such —
// good for the month-on-month trend, which is what the page is for.
//
// ── What it fills in ─────────────────────────────────────────────────────────────────────────────
// Mentioned, position and "linked to our site" are read off the text (src/utils/ai-visibility.ts
// detectMention), and known competitors are matched by name. "Accurate?" is left blank on purpose —
// it needs a person who knows the facts.
//
// A MANUAL answer is never overwritten: an admin who typed something in meant it. An existing API
// answer is replaced only when the admin asked for a refetch (overwrite: true).

import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiVisibilityQuestions, aiVisibilityAnswers } from '../../db/schema';
import { gatewayGenerateGrounded } from '../../src/lib/ai-gateway';
import { AUTO_ANSWER_SYSTEM, AUTO_ASSISTANTS, detectMention, detectCompetitors, type AssistantKey } from '../../src/utils/ai-visibility';
import { withLambda } from '@netlify/aws-lambda-compat';

// A Claude answer with web search measured 45 s (2026-10-29), so 50 calls three at a time ran close to
// the 15-minute ceiling. Five at a time, and no new call starts after 11 minutes — the longest call
// (CLAUDE_BUDGET_MS, 3 min) started then still ends inside 15. Whatever is left stays empty, and
// pressing "Fetch" again fills only the empty and failed cells.
const CONCURRENCY = 5;
const STOP_STARTING_AFTER_MS = 11 * 60 * 1000;
const OPENAI_TIMEOUT_MS = 150_000;
// The model OpenAI recommends for web search (developers.openai.com, tools-web-search, Oct 2026),
// closest to what ChatGPT itself runs. An account without access to it falls back once to gpt-5.
const OPENAI_MODEL = process.env.AI_VISIBILITY_OPENAI_MODEL || 'gpt-5.5';
const OPENAI_FALLBACK_MODEL = 'gpt-5';

interface Fetched { text: string; urls: string[]; model: string }

// ⚠️ Pass a deadline. Without one the gateway falls back to its client's 24 s PER-ATTEMPT timeout
// (built for request paths), and an answer that searches the web takes ~45 s — so on the first
// production run (2026-10-29) 22 of 25 Claude calls ended "Request timed out." A deadline makes the
// gateway give the call the whole remaining budget, with no hidden retries. The gateway still
// records the cost in ai_usage_log.
const CLAUDE_BUDGET_MS = 180_000;

async function askClaude(question: string): Promise<Fetched> {
    const gw = await gatewayGenerateGrounded({
        system: AUTO_ANSWER_SYSTEM,
        messages: [{ role: 'user', content: question }],
        maxTokens: 2500,
        deadlineMs: CLAUDE_BUDGET_MS,
    });
    return { text: gw.text, urls: gw.searchedUrls, model: gw.model };
}

/** Text and cited URLs out of an OpenAI Responses API reply (the REST shape has no output_text). */
export function readOpenAiResponse(data: any): { text: string; urls: string[] } {
    const parts: string[] = [];
    const urls: string[] = [];
    for (const item of Array.isArray(data?.output) ? data.output : []) {
        if (item?.type !== 'message') continue;
        for (const c of Array.isArray(item.content) ? item.content : []) {
            if (c?.type !== 'output_text') continue;
            parts.push(String(c.text || ''));
            for (const a of Array.isArray(c.annotations) ? c.annotations : []) {
                if (a?.type === 'url_citation' && typeof a.url === 'string') urls.push(a.url);
            }
        }
    }
    return { text: parts.join('\n\n').trim(), urls: [...new Set(urls)] };
}

async function askChatGpt(question: string): Promise<Fetched> {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('OPENAI_API_KEY is not set.');
    let model = OPENAI_MODEL;
    const call = (toolType: string) => fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
            model,
            instructions: AUTO_ANSWER_SYSTEM,
            input: question,
            tools: [{ type: toolType, user_location: { type: 'approximate', country: 'GB' } }],
        }),
        signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
    });
    let res = await call('web_search');
    if (res.status === 400 || res.status === 404) {
        const body = await res.text();
        if (/model/i.test(body) && model !== OPENAI_FALLBACK_MODEL) {
            // No access to the preferred model on this account: one retry on the fallback.
            model = OPENAI_FALLBACK_MODEL;
            res = await call('web_search');
        } else if (/web_search/i.test(body)) {
            // An API version that only knows the legacy tool name.
            res = await call('web_search_preview');
        } else {
            throw new Error(`OpenAI HTTP ${res.status}: ${body.slice(0, 300)}`);
        }
    }
    if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    const { text, urls } = readOpenAiResponse(data);
    if (!text) throw new Error('OpenAI returned no answer text.');
    return { text, urls, model: String(data?.model || model) };
}

const ASK: Record<string, (q: string) => Promise<Fetched>> = { claude: askClaude, chatgpt: askChatGpt };

/** Run `fn` over `items`, at most `limit` at a time. */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>, stopAt = Infinity): Promise<number> {
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length && Date.now() < stopAt) await fn(items[next++]);
    });
    await Promise.all(workers);
    return items.length - next; // left unstarted
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!secret) return { statusCode: 503, body: JSON.stringify({ error: 'Trigger not configured.' }) };
    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    if (auth.replace(/^Bearer\s+/i, '').trim() !== secret) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    let body: { runId?: number; assistants?: string[]; overwrite?: boolean; adminId?: number } = {};
    try { body = JSON.parse(event.body || '{}'); } catch { /* validated below */ }
    const runId = Number(body.runId);
    const assistants = AUTO_ASSISTANTS.filter((a) => (body.assistants || AUTO_ASSISTANTS).includes(a));
    if (!runId || !assistants.length) return { statusCode: 400, body: JSON.stringify({ error: 'runId and assistants required.' }) };

    const db = getDb();
    const questions = await db.select().from(aiVisibilityQuestions).where(eq(aiVisibilityQuestions.isActive, true));
    const existing = await db.select().from(aiVisibilityAnswers).where(eq(aiVisibilityAnswers.runId, runId));
    const has = (q: number, a: string) => existing.find((r) => r.questionId === q && r.assistant === a);

    const jobs: Array<{ q: typeof questions[number]; a: AssistantKey }> = [];
    for (const q of questions) for (const a of assistants) {
        const prev = has(q.id, a);
        if (prev?.source === 'manual') continue;           // never replace what an admin typed
        if (prev && prev.mentioned !== null && !body.overwrite) continue; // already answered
        jobs.push({ q, a });
    }

    let ok = 0, failed = 0;
    const startedAt = Date.now();
    const skipped = await pool(jobs, CONCURRENCY, async ({ q, a }) => {
        const where = and(eq(aiVisibilityAnswers.runId, runId), eq(aiVisibilityAnswers.questionId, q.id), eq(aiVisibilityAnswers.assistant, a));
        try {
            const got = await ASK[a](q.text);
            const m = detectMention(got.text, got.urls);
            const values = {
                source: 'api', mentioned: m.mentioned, position: m.position, link: m.link,
                accurate: null, wrongFacts: null, competitors: detectCompetitors(got.text, a), notes: null,
                answerText: got.text.slice(0, 20000), citedUrls: got.urls.slice(0, 50), model: got.model, error: null,
                answeredBy: body.adminId ?? null, answeredAt: new Date(),
            };
            const [row] = await db.select({ id: aiVisibilityAnswers.id, source: aiVisibilityAnswers.source }).from(aiVisibilityAnswers).where(where).limit(1);
            if (row?.source === 'manual') return; // typed in while this was running — theirs wins
            if (row) await db.update(aiVisibilityAnswers).set(values).where(eq(aiVisibilityAnswers.id, row.id));
            else await db.insert(aiVisibilityAnswers).values({ runId, questionId: q.id, assistant: a, ...values }).onConflictDoNothing();
            ok++;
        } catch (err) {
            failed++;
            const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
            console.error(`[ai-visibility-fetch] run ${runId} q${q.id} ${a}:`, message);
            // Record the failure so the page can show it, without disturbing a good earlier answer.
            const [row] = await db.select({ id: aiVisibilityAnswers.id, mentioned: aiVisibilityAnswers.mentioned }).from(aiVisibilityAnswers).where(where).limit(1);
            if (!row) {
                await db.insert(aiVisibilityAnswers).values({ runId, questionId: q.id, assistant: a, source: 'api', error: message, mentioned: null }).onConflictDoNothing();
            } else if (row.mentioned === null) {
                await db.update(aiVisibilityAnswers).set({ error: message, answeredAt: new Date() }).where(eq(aiVisibilityAnswers.id, row.id));
            }
        }
    }, startedAt + STOP_STARTING_AFTER_MS);

    console.log(`[ai-visibility-fetch] run ${runId}: ${ok} answered, ${failed} failed, ${skipped} not started (time), ${jobs.length} queued (${assistants.join(', ')})`);
    return { statusCode: 200, body: JSON.stringify({ ok, failed, notStarted: skipped, queued: jobs.length }) };
});
