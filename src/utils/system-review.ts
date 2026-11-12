// src/utils/system-review.ts — System Map Phase 3 (docs/system-map-plan.md): "Better options".
//
// For each paid system, Claude (Opus 5.5, server-side web search) checks whether a better tool exists
// for quality, features or price, given what we use it for, what we pay and what the owner already
// decided. The answer is stored as a DATED OPINION with sources; nothing is ever switched.
//
// Sources are allow-listed: a URL is kept only if the search tool itself returned it
// (gatewayGenerateGrounded's searchedUrls). A model asked for alternatives will happily invent a
// pricing page; an invented link presented as a source is worse than none.
//
// Pure parts (which systems, prompt, parsing) are exported for tests; runSystemReview() does the call
// and the write.

import { eq, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { systemReviews } from '../../db/schema';
import { gatewayGenerateGrounded } from '../lib/ai-gateway';
import { logServiceCost } from './ai-usage';

type Db = ReturnType<typeof getDb>;

/**
 * Systems worth checking: third-party products we pay for (or could). Not checked: our own config and
 * secrets (auth, vault, cron, app URL), sub-entries of another system (fal balance alerts, email
 * domains/webhooks), free public data (Companies House), and customer connectors (the customer
 * picks their own CRM — there's nothing for us to switch).
 */
export const REVIEWABLE_SYSTEMS = [
    'anthropic', 'openai', 'fal', 'elevenlabs', 'stability', 'embeddings', 'remotion', 'pexels',
    'r2', 'neon', 'resend', 'stripe', 'serper', 'hunter', 'netlify', 'porkbun',
] as const;
export const isReviewable = (key: string) => (REVIEWABLE_SYSTEMS as readonly string[]).includes(key);

export const REVIEW_MODEL = 'claude-opus-5-5';
export const BETTER_FOR = ['quality', 'features', 'price'] as const;
export const SWITCHING_EFFORT = ['low', 'medium', 'high'] as const;
export const VERDICTS = ['keep', 'consider', 'switch'] as const;

export interface ReviewContext {
    name: string;
    purpose: string;
    category: string;
    version: string;                 // API / SDK / models we call
    models: Array<{ model: string; spend30Gbp: number; roles30: string[] }>;
    spend30Gbp: number;
    fixedBills: string[];            // "Pro plan: USD 19.00/month"
    decisions: string[];             // decisions already taken — never re-suggest these
    previousSummary: string | null;  // last check's summary, so a re-check says what changed
}

export const REVIEW_SYSTEM = `You review one piece of Be More Swan's technology stack. Be More Swan is a UK SaaS: AI assistants that draft social posts, blogs, emails, videos and websites for small businesses, on Netlify with a Neon Postgres database. Your job: is there a better tool on the market today for what we use this system for — better QUALITY, better FEATURES, or a better PRICE for our usage?

Method:
- Search the web for current options and current prices. Prefer the providers' own pricing and docs pages, and independent benchmarks. Today's facts beat what you remember.
- Judge against what WE use it for and what we spend (given below), not in general. A cheaper tool that can't do what we need is not better.
- Respect the decisions already taken. Never suggest something a decision says was turned down or chosen against, unless you found a material change since that decision (say exactly what changed).
- Count the cost of switching honestly: code to rewrite, quality risk, contracts, data to move.
- If nothing is clearly better, say "keep". That is a good answer, not a failure.

Reply with ONE JSON object and nothing else:
{
  "verdict": "keep" | "consider" | "switch",
  "summary": "2–4 plain British English sentences: what we have, whether anything beats it, and why",
  "alternatives": [
    {
      "name": "product name (and model/plan if it matters)",
      "url": "the page you found it on — only a URL your search returned",
      "betterFor": ["quality" | "features" | "price", ...],
      "detail": "1–2 sentences: what is better, with figures where you found them",
      "priceNote": "what it would cost us at our usage, or '' if unknown",
      "switchingEffort": "low" | "medium" | "high"
    }
  ],
  "caveats": "anything you could not confirm, or ''"
}
At most 3 alternatives, best first. "switch" only when an alternative is clearly better AND worth the switching effort.`;

export function buildReviewPrompt(c: ReviewContext): string {
    const lines = [
        `SYSTEM: ${c.name} (${c.category})`,
        `WHAT WE USE IT FOR: ${c.purpose}`,
        c.version ? `VERSION / MODELS WE CALL: ${c.version}` : '',
        c.models.length ? `MODELS AND WHO USES THEM (last 30 days):\n${c.models.map((m) => `- ${m.model}: £${m.spend30Gbp.toFixed(2)}${m.roles30.length ? `, used by ${m.roles30.join(', ')}` : ''}`).join('\n')}` : '',
        `WHAT WE SPEND: £${c.spend30Gbp.toFixed(2)} in the last 30 days${c.fixedBills.length ? ` (monthly bills: ${c.fixedBills.join('; ')})` : ''}.`,
        `DECISIONS ALREADY TAKEN (respect these):\n${c.decisions.length ? c.decisions.map((d) => `- ${d}`).join('\n') : '- none recorded'}`,
        c.previousSummary ? `LAST CHECK SAID: ${c.previousSummary}\nSay if anything has changed since.` : '',
    ];
    return lines.filter(Boolean).join('\n\n');
}

export interface Alternative { name: string; url: string | null; betterFor: string[]; detail: string; priceNote: string; switchingEffort: string }
export interface ParsedReview { verdict: 'keep' | 'consider' | 'switch'; summary: string; alternatives: Alternative[]; caveats: string; sources: string[] }

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
/** Same page whatever the www., trailing slash, fragment or tracking query. Pure. */
export function normaliseUrl(u: string): string {
    try {
        const x = new URL(u);
        x.hash = '';
        for (const k of [...x.searchParams.keys()]) if (/^utm_|^ref$|^srsltid$/i.test(k)) x.searchParams.delete(k);
        return `${x.protocol}//${x.host.toLowerCase().replace(/^www\./, '')}${x.pathname.replace(/\/+$/, '')}${x.search}`;
    } catch { return ''; }
}

/**
 * The model's JSON → a review we can store, or null when there is no usable JSON. Pure.
 * Any URL not in `searchedUrls` is dropped; sources = the alternatives' surviving URLs, then up to 8.
 */
export function parseReview(text: string, searchedUrls: string[]): ParsedReview | null {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    let raw: any;
    try { raw = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
    if (!raw || typeof raw !== 'object') return null;
    const verdict = (VERDICTS as readonly string[]).includes(raw.verdict) ? raw.verdict : null;
    const summary = str(raw.summary, 1200);
    if (!verdict || !summary) return null;

    const allowed = new Map(searchedUrls.map((u) => [normaliseUrl(u), u] as const).filter(([k]) => k));
    const alternatives: Alternative[] = (Array.isArray(raw.alternatives) ? raw.alternatives : []).slice(0, 3)
        .map((a: any): Alternative | null => {
            const name = str(a?.name, 120);
            if (!name) return null;
            const url = typeof a?.url === 'string' ? allowed.get(normaliseUrl(a.url)) ?? null : null;
            return {
                name,
                url,
                betterFor: (Array.isArray(a?.betterFor) ? a.betterFor : []).filter((b: unknown) => (BETTER_FOR as readonly string[]).includes(b as string)),
                detail: str(a?.detail, 600),
                priceNote: str(a?.priceNote, 300),
                switchingEffort: (SWITCHING_EFFORT as readonly string[]).includes(a?.switchingEffort) ? a.switchingEffort : 'medium',
            };
        })
        .filter((a: Alternative | null): a is Alternative => !!a);
    // "keep" with no alternatives is fine; "switch"/"consider" with none to show is not credible.
    const finalVerdict = verdict !== 'keep' && !alternatives.length ? 'keep' : verdict;
    const sources = [...new Set(alternatives.map((a) => a.url).filter((u): u is string => !!u))].slice(0, 8);
    return { verdict: finalVerdict, summary, alternatives, caveats: str(raw.caveats, 600), sources };
}

const REVIEW_DEADLINE_MS = 240_000;

/** Run one queued review row to done/failed. Never throws. */
export async function runSystemReview(db: Db, reviewId: number, ctx: ReviewContext): Promise<'done' | 'failed'> {
    await db.update(systemReviews).set({ status: 'running' }).where(eq(systemReviews.id, reviewId));
    try {
        const res = await gatewayGenerateGrounded({
            system: REVIEW_SYSTEM,
            messages: [{ role: 'user', content: buildReviewPrompt(ctx) }],
            maxTokens: 6000,
            deadlineMs: REVIEW_DEADLINE_MS,
            model: REVIEW_MODEL,
            thinking: 'low',
            usage: { sessionId: 'system-review', dataCategories: ['business_context'] },
        });
        // Web search is billed per search on top of tokens; the gateway records only the tokens.
        logServiceCost('anthropic-web-search', res.searchCount, { sessionId: 'system-review' });
        const parsed = parseReview(res.text, res.searchedUrls);
        if (!parsed) throw new Error(res.stopReason === 'max_tokens' ? 'The answer was cut off before it finished.' : 'The answer had no usable result.');
        await db.update(systemReviews).set({
            status: 'done', verdict: parsed.verdict,
            summary: parsed.caveats ? `${parsed.summary}\n\nNot confirmed: ${parsed.caveats}` : parsed.summary,
            alternatives: parsed.alternatives, sources: parsed.sources,
            model: res.model, searchCount: res.searchCount, error: null, finishedAt: new Date(),
        }).where(eq(systemReviews.id, reviewId));
        return 'done';
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[system-review] review ${reviewId} (${ctx.name}) failed:`, msg);
        await db.update(systemReviews).set({ status: 'failed', error: msg.slice(0, 500), finishedAt: new Date() })
            .where(eq(systemReviews.id, reviewId)).catch(() => {});
        return 'failed';
    }
}

// ── Queueing and the worker ─────────────────────────────────────────────────────────────────────

/** A review still 'queued'/'running' after this long died with its worker; it reads as failed. */
export const STALE_REVIEW_MS = 20 * 60_000;

/** What the page shows for one review row. Pure. */
export function reviewState(r: { status: string; createdAt: string | Date }, now = new Date()): 'queued' | 'running' | 'done' | 'failed' | 'stalled' {
    if ((r.status === 'queued' || r.status === 'running') && now.getTime() - new Date(r.createdAt).getTime() > STALE_REVIEW_MS) return 'stalled';
    return r.status as 'queued' | 'running' | 'done' | 'failed';
}

/** The review context for one system on the map. Pure. */
export function reviewContextFor(
    s: { name: string; purpose?: unknown; category: string; version?: unknown; models?: Array<{ model: string; spend30Gbp: number; roles30: string[] }>; spend?: { total30Gbp: number }; fixedCosts?: Array<{ label: string; currency: string; amountMonthly: number; endedOn: string | null }>; decisions?: Array<{ decision: string }>; review?: { summary?: string } | null },
    roleNames: Record<string, string> = {},
): ReviewContext {
    const v = (s.version ?? {}) as { api?: string; sdk?: string };
    return {
        name: s.name,
        purpose: String(s.purpose ?? ''),
        category: s.category,
        version: [v.api, v.sdk].filter(Boolean).join(' · '),
        models: (s.models ?? []).map((m) => ({ model: m.model, spend30Gbp: m.spend30Gbp, roles30: m.roles30.map((r) => roleNames[r] ?? r) })),
        spend30Gbp: s.spend?.total30Gbp ?? 0,
        fixedBills: (s.fixedCosts ?? []).filter((b) => !b.endedOn).map((b) => `${b.label || 'bill'}: ${b.currency} ${Number(b.amountMonthly).toFixed(2)}/month`),
        decisions: (s.decisions ?? []).map((d) => d.decision),
        previousSummary: s.review?.summary ? s.review.summary.slice(0, 600) : null,
    };
}

/**
 * Queue a review for each system (skipping any already queued or running), and return the new row
 * ids for the worker. Unknown or non-reviewable keys are ignored.
 */
export async function queueSystemReviews(db: Db, keys: string[], trigger: 'manual' | 'monthly' | 'chat', requestedBy: number | null): Promise<number[]> {
    const wanted = [...new Set(keys)].filter(isReviewable);
    if (!wanted.length) return [];
    const open = await db.execute<{ system_key: string }>(sql`
        SELECT DISTINCT system_key FROM system_reviews
        WHERE status IN ('queued', 'running') AND created_at > now() - make_interval(secs => ${STALE_REVIEW_MS / 1000})`);
    const busy = new Set([...open].map((r) => r.system_key));
    const fresh = wanted.filter((k) => !busy.has(k));
    if (!fresh.length) return [];
    const rows = await db.insert(systemReviews).values(fresh.map((systemKey) => ({ systemKey, trigger, requestedBy }))).returning({ id: systemReviews.id });
    return rows.map((r) => r.id);
}

/** Wake the background worker. Awaited (an un-awaited fetch can be frozen with the lambda). Returns
 *  null on success or a sentence saying why it couldn't start. */
export async function startReviewWorker(base: string | null, reviewIds: number[]): Promise<string | null> {
    if (!reviewIds.length) return null;
    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!secret) return 'CRON_TRIGGER_SECRET is not set on this site, so the check cannot start.';
    if (!base) return 'Could not work out this site\'s address.';
    try {
        const res = await fetch(`${base}/.netlify/functions/system-review-background`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
            body: JSON.stringify({ reviewIds }),
            signal: AbortSignal.timeout(8_000),
        });
        return res.status === 202 || res.ok ? null : `The checker refused to start (HTTP ${res.status}).`;
    } catch (err) {
        return `The checker could not be reached: ${err instanceof Error ? err.message : String(err)}`;
    }
}

export interface ReviewRow { id: number; systemKey: string; status: string; verdict: string | null; summary: string; alternatives: unknown; sources: unknown; model: string | null; searchCount: number; error: string | null; trigger: string; createdAt: string; finishedAt: string | null }
export interface DecisionRow { id: number; systemKey: string; decision: string; createdAt: string }

/**
 * Give each system its latest finished review, the state of any check in progress, its decisions and
 * whether it is checked at all. Pure. `reviews` newest first.
 */
export function attachReviews<S extends { key: string }>(systems: S[], reviews: ReviewRow[], decisions: DecisionRow[], now = new Date()) {
    return systems.map((s) => {
        const mine = reviews.filter((r) => r.systemKey === s.key);
        const latest = mine[0] ?? null;
        const lastDone = mine.find((r) => r.status === 'done') ?? null;
        const latestState = latest ? reviewState(latest, now) : null;
        return {
            ...s,
            reviewable: isReviewable(s.key),
            review: lastDone,
            // The newest attempt when it is not the finished one shown: in progress, failed or stalled.
            reviewAttempt: latest && latest !== lastDone ? { state: latestState, error: latest.error, createdAt: latest.createdAt } : null,
            decisions: decisions.filter((d) => d.systemKey === s.key),
        };
    });
}

export type ReviewRequest =
    | { action: 'check_now'; systemKeys: string[] }
    | { action: 'add_decision'; systemKey: string; decision: string }
    | { action: 'retire_decision'; id: number };

/** Checks a review/decision request from the page or a chat card. Pure. */
export function validateReviewRequest(body: Record<string, unknown>, knownSystemKeys: string[]): { ok: ReviewRequest } | { error: string } {
    if (body.action === 'check_now') {
        const raw = body.systemKeys === 'all' ? [...REVIEWABLE_SYSTEMS] : Array.isArray(body.systemKeys) ? body.systemKeys.map(String) : [];
        const keys = [...new Set(raw)].filter((k) => knownSystemKeys.includes(k) && isReviewable(k));
        if (!keys.length) return { error: 'Pick a system that is checked for better options.' };
        return { ok: { action: 'check_now', systemKeys: keys } };
    }
    if (body.action === 'add_decision') {
        const systemKey = String(body.systemKey ?? '');
        if (!knownSystemKeys.includes(systemKey)) return { error: 'Pick a system from the map.' };
        const decision = String(body.decision ?? '').replace(/\s+/g, ' ').trim();
        if (decision.length < 3) return { error: 'Write the decision in a few words.' };
        if (decision.length > 500) return { error: 'Keep the decision under 500 characters.' };
        return { ok: { action: 'add_decision', systemKey, decision } };
    }
    if (body.action === 'retire_decision') {
        const id = Number(body.id);
        if (!Number.isInteger(id) || id <= 0) return { error: 'That decision was not found.' };
        return { ok: { action: 'retire_decision', id } };
    }
    return { error: 'Unknown action.' };
}
