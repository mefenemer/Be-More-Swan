// src/utils/site-taster.ts — the Mystery Shopper's free public taster (docs/mystery-shopper-plan.md §4.7).
//
// Anyone on bemoreswan.com/mystery-shopper enters a website and an email; we read that one page, ask
// the first-impression questions only, and show a score out of 100 plus the single worst problem
// with a rewrite. Same machinery as a hired check (site-extract, site-score, the clarity lens prompt),
// so a taster score and a hired score for the same page agree on that lens.
//
// PURE helpers here (tokens, hashes, the result shape); the endpoint is site-audit-public.ts and the
// work runs in run-site-audit-background.ts (site-audit.ts executeTasterRun).
//
// What this file guarantees, and tests/site-taster.test.ts pins:
//   · A result is only readable with its token — an HMAC of the run id — so run ids cannot be walked
//     to read other people's results, and nothing has to be stored to check it.
//   · The visitor's email address is NEVER stored. Only a hash (for the per-person limit) is kept; the
//     address itself travels to the worker once, to send the result, and is dropped.
//   · The public result carries no page dump — the score, what failed, and one grounded fix.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { SitePage } from './site-extract';
import { groundFixes, sanitiseRubricAnswers, scoreTaster, type SuggestedFix } from './site-score';

/** Abuse limits. Per IP per hour, per email per day, and a platform-wide daily cap on model calls. */
export const TASTER_LIMITS = {
    perIp: { maxAttempts: 5, windowSecs: 3600 },
    perEmail: { maxAttempts: 3, windowSecs: 86_400 },
    /** Overridable with SITE_TASTER_DAILY_CAP. Cached results never count. */
    dailyCapDefault: 300,
    /** The same page checked again within this long gets the earlier result, free. */
    cacheHours: 24,
    /** A form filled in faster than this was not filled in by a person (same rule as sign-up forms). */
    minFillMs: 1500,
} as const;

export function dailyCap(): number {
    const n = Number(process.env.SITE_TASTER_DAILY_CAP);
    return Number.isInteger(n) && n >= 0 ? n : TASTER_LIMITS.dailyCapDefault;
}

function secret(): string | null {
    return process.env.SITE_TASTER_SECRET || process.env.CRON_TRIGGER_SECRET || null;
}

/** The token that unlocks one result. Null when no secret is configured (the taster is then off). */
export function tasterToken(runId: number, key: string | null = secret()): string | null {
    if (!key) return null;
    return createHmac('sha256', key).update(`site-taster:${runId}`).digest('hex').slice(0, 32);
}

export function verifyTasterToken(runId: number, token: unknown, key: string | null = secret()): boolean {
    const want = tasterToken(runId, key);
    if (!want || typeof token !== 'string' || token.length !== want.length) return false;
    return timingSafeEqual(Buffer.from(want), Buffer.from(token));
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** The cache key for a page: same page, however it was typed (case, trailing slash, www). */
export function tasterUrlHash(url: string): string {
    let u: URL;
    try { u = new URL(url); } catch { return sha(url.trim().toLowerCase()); }
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return sha(`${host}${path}${u.search}`);
}

export function tasterEmailHash(email: string): string {
    return sha(`site-taster-email:${email.trim().toLowerCase()}`);
}

export interface TasterResult {
    url: string;
    /** 0–100, or null when the page could not be read. */
    score: number | null;
    /** What failed, heaviest first, at most five — the "what's costing you" list. */
    failures: string[];
    /** The single most important fix, quoting the page. Null when none was grounded. */
    worstFix: { location: string; problem: string; currentText: string; suggestedText: string } | null;
    /** One plain sentence, written in code from the score — no model prose on a public page. */
    summary: string;
    unreadable: boolean;
}

export function unreadableResult(url: string): TasterResult {
    return {
        url, score: null, failures: [], worstFix: null, unreadable: true,
        summary: 'This page shows almost no text until JavaScript runs, so there was nothing for a buyer — or most AI crawlers — to read. That is the first thing to fix.',
    };
}

/**
 * The public result from one page and one first-impression lens reply. Pure. The reply is untrusted
 * model output: answers and the fix go through the same grounding as a hired check, and a reply with
 * no usable answer returns null (the run then fails rather than showing a code-only score).
 */
export function buildTasterResult(page: SitePage, rawReply: unknown): TasterResult | null {
    if (page.thin) return unreadableResult(page.url);
    const raw = (rawReply && typeof rawReply === 'object' ? rawReply : {}) as { answers?: unknown; fixes?: unknown };
    const { answers } = sanitiseRubricAnswers(raw.answers, 'clarity', page);
    if (!answers.length) return null;
    const lens = scoreTaster(page, answers);
    const { fixes } = groundFixes(raw.fixes, 'clarity', page);
    // The headline and the top button are what a five-second visitor sees — prefer a fix there.
    const rank = (f: SuggestedFix) => (/headline|h1|hero/i.test(f.location) ? 0 : /button|cta/i.test(f.location) ? 1 : 2);
    const worst = [...fixes].sort((a, b) => rank(a) - rank(b))[0] ?? null;
    const score = lens.score;
    const band = score === null ? '' : score >= 80 ? 'Strong — a first-time visitor gets it quickly.'
        : score >= 60 ? 'Decent, with gaps a first-time visitor will notice.'
        : score >= 40 ? 'A first-time visitor would struggle to see why they should stay.'
        : 'Most first-time visitors would leave before they understood what you offer.';
    return {
        url: page.url,
        score,
        failures: lens.failures.slice(0, 5).map((f) => f.label),
        worstFix: worst ? { location: worst.location, problem: worst.problem, currentText: worst.currentText, suggestedText: worst.suggestedText } : null,
        summary: score === null ? 'We could not score this page.' : `First impression: ${score} out of 100. ${band}`,
        unreadable: false,
    };
}

