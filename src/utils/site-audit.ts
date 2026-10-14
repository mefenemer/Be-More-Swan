// src/utils/site-audit.ts — the Mystery Shopper's run pipeline. docs/mystery-shopper-plan.md §4.4.
//
// Two layers, so the decisions can be tested without a database or a network:
//   runAuditCore()     — PURE apart from its injected deps (fetch a page, call a model, ask for
//                        capacity). Decides everything: unchanged / unreadable / failed / done, the
//                        score, the grounded fixes, the summary, and whether a task is charged.
//                        tests/site-audit-pipeline.test.ts drives it with fakes.
//   executeAuditRun()  — loads the run and its audit, wires the real deps, and writes the outcome.
//                        Called by the background worker (run-site-audit-background.ts).
//
// The money rules, all decided in the core and pinned by tests:
//   · A task is charged ONLY for a run that re-scored (status 'done'). Unchanged, unreadable and
//     failed runs are free (decision D4, 2026-10-14).
//   · No model is called before the capacity check, and none at all when nothing changed.
//   · If every lens call fails, the run fails and is free — a score built from code checks alone
//     would be presented as a real review when the review never happened.
//   · The charge is recorded AFTER the run is latched 'done' (work-metering.ts rule).

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, siteAuditFixes, siteAuditRuns, siteAudits } from '../../db/schema';
import { loadAssistantRulesBlock } from './assistant-rules-prompt';
import { resolveBaseUrl } from './base-url';
import { sendTemplatedEmail } from './email';
import { buildTasterResult, tasterToken, unreadableResult, type TasterResult } from './site-taster';
import { gatewayGenerate } from '../lib/ai-gateway';
import { CRAWLERS, robotsAllows } from '../lib/robots';
import { parseModelJson } from './model-json';
import { createNotification } from './notify';
import { loadProductsBlock } from './org-products';
import { safeFetchText, SafeFetchError } from './safe-fetch';
import {
    buildLensPrompt, buildSummaryPrompt, sanitiseSummary, type AuditBrief, type Handoff, type Priority,
} from './site-audit-prompts';
import {
    describeChanges, diffSitePages, extractSitePage, pickSecondaryPages, siteContentHash, normaliseText, type SitePage,
} from './site-extract';
import {
    groundFixes, isGrounded, sanitiseRubricAnswers, scoreAudit, type AuditScore, type Lens, type RubricAnswer, type SuggestedFix,
} from './site-score';
import { hasTaskCapacity, recordCompletedWork, TASK_LIMIT_MESSAGE } from './work-metering';

type Db = ReturnType<typeof getDb>;

export const MAX_COMPETITORS = 3;
/** Pages read on each competitor's site beyond its homepage (plan §3.6). */
export const COMPETITOR_EXTRA_PAGES = 2;
/** A run still queued or running after this is assumed dead and is ended, free. */
export const RUN_TIMEOUT_MS = 15 * 60 * 1000;

const FETCH_TIMEOUT_MS = 12_000;
const FETCH_MAX_BYTES = 3 * 1024 * 1024;

// ── URLs ────────────────────────────────────────────────────────────────────────────────────

/**
 * A URL the user typed, made fetchable: scheme added if missing, http(s) only, no credentials, a
 * real-looking host, no fragment. Returns null for anything else. (safe-fetch.ts still does the
 * real SSRF checks at fetch time — this is about giving a clear message at save time.)
 */
export function normaliseSiteUrl(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    let s = raw.trim();
    if (!s || s.length > 500) return null;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
    let u: URL;
    try { u = new URL(s); } catch { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(u.hostname)) return null;
    u.hash = '';
    return u.toString();
}

/** Same site, ignoring scheme and a leading www. — so a competitor can't be the user's own site. */
export function sameSite(a: string, b: string): boolean {
    const host = (s: string) => { try { return new URL(s).hostname.replace(/^www\./i, '').toLowerCase(); } catch { return s; } };
    return host(a) === host(b);
}

// ── The core ────────────────────────────────────────────────────────────────────────────────

export type FetchResult = { ok: true; page: SitePage } | { ok: false; message: string };

export interface AuditDeps {
    /** Read one page. Never throws. */
    fetchPage(url: string): Promise<FetchResult>;
    /** One model call; resolves to the reply text. May throw — a lens that throws is skipped. */
    callModel(req: { system: string; user: string; maxTokens: number }): Promise<string>;
    /** Has the workspace a task left? (Always true for the public taster.) */
    hasCapacity(): Promise<boolean>;
}

export interface AuditInput {
    kind: 'baseline' | 'weekly' | 'manual';
    brief: AuditBrief;
    competitorUrls: string[];
    /** Hashes from the last read, keyed 'site' and by competitor URL. */
    lastHashes: Record<string, string>;
    /** Pages from the last read, same keys — for competitor change lines. */
    previousPages: Record<string, SitePage>;
    previousScore: number | null;
}

export interface AuditReport {
    summary: string;
    priorities: Priority[];
    handoffs: Handoff[];
    competitorChanges: Array<{ url: string; changes: string[] }>;
    /** Competitors we could not read, with the reason — shown, never silently dropped. */
    competitorsUnread: Array<{ url: string; message: string }>;
    /** Lenses whose model call failed this time (scored on code checks only). */
    partialLenses: Lens[];
}

export type AuditOutcome =
    | { status: 'failed'; error: string }
    | { status: 'unreadable'; pages: Record<string, SitePage>; hashes: Record<string, string> }
    | { status: 'unchanged'; pages: Record<string, SitePage>; hashes: Record<string, string> }
    | {
        status: 'done';
        pages: Record<string, SitePage>;
        hashes: Record<string, string>;
        score: AuditScore;
        fixes: SuggestedFix[];
        report: AuditReport;
        groundingDropped: number;
    };

/** The key the user's own page is stored under in pages/hashes. */
export const SITE_KEY = 'site';

const LENS_MAX_TOKENS = 2000;
const SUMMARY_MAX_TOKENS = 1200;

/** Merge a competitor's pricing/about pages into its homepage read: pricing, proof and FAQ only. */
export function mergeSecondary(home: SitePage, extras: SitePage[]): SitePage {
    if (!extras.length) return home;
    const join = (a: string[], more: string[][], cap: number) => {
        const seen = new Set(a.map(normaliseText));
        const out = [...a];
        for (const s of more.flat()) {
            const k = normaliseText(s);
            if (seen.has(k)) continue;
            seen.add(k);
            out.push(s);
            if (out.length >= cap) break;
        }
        return out;
    };
    return {
        ...home,
        structure: {
            ...home.structure,
            pricingSignals: join(home.structure.pricingSignals, extras.map((e) => e.structure.pricingSignals), 12),
            proofSnippets: join(home.structure.proofSnippets, extras.map((e) => e.structure.proofSnippets), 10),
            faqQuestions: join(home.structure.faqQuestions, extras.map((e) => e.structure.faqQuestions), 15),
        },
        seo: { ...home.seo, schemaTypes: [...new Set([...home.seo.schemaTypes, ...extras.flatMap((e) => e.seo.schemaTypes)])] },
    };
}

async function readCompetitor(url: string, deps: AuditDeps): Promise<FetchResult> {
    const home = await deps.fetchPage(url);
    if (!home.ok || home.page.thin) return home;
    const extras = await Promise.all(pickSecondaryPages(home.page, COMPETITOR_EXTRA_PAGES).map((u) => deps.fetchPage(u)));
    return { ok: true, page: mergeSecondary(home.page, extras.flatMap((e) => (e.ok && !e.page.thin ? [e.page] : []))) };
}

export async function runAuditCore(input: AuditInput, deps: AuditDeps): Promise<AuditOutcome> {
    const competitorUrls = input.competitorUrls.slice(0, MAX_COMPETITORS);
    const [own, ...theirs] = await Promise.all([
        deps.fetchPage(input.brief.url),
        ...competitorUrls.map((u) => readCompetitor(u, deps)),
    ]);
    if (!own.ok) return { status: 'failed', error: own.message };

    const pages: Record<string, SitePage> = { [SITE_KEY]: own.page };
    const hashes: Record<string, string> = { [SITE_KEY]: siteContentHash(own.page) };
    const competitorsUnread: AuditReport['competitorsUnread'] = [];
    const readable: Array<{ url: string; page: SitePage }> = [];
    competitorUrls.forEach((url, i) => {
        const r = theirs[i];
        if (!r.ok) { competitorsUnread.push({ url, message: r.message }); return; }
        pages[url] = r.page;
        hashes[url] = siteContentHash(r.page);
        if (r.page.thin) competitorsUnread.push({ url, message: 'That page shows almost no text without JavaScript, so there was nothing to compare.' });
        else readable.push({ url, page: r.page });
    });

    // Nothing changed anywhere since the last read → carry the score forward, free (plan §3.1).
    // A competitor we failed to read this time has no hash, so the sets differ and we re-score —
    // never "unchanged" on the strength of a read that didn't happen.
    const sameKeys = Object.keys(hashes).length === Object.keys(input.lastHashes).length;
    if (input.kind !== 'baseline' && input.previousScore !== null && sameKeys &&
        Object.entries(hashes).every(([k, h]) => input.lastHashes[k] === h)) {
        return { status: 'unchanged', pages, hashes };
    }

    if (own.page.thin) return { status: 'unreadable', pages, hashes };

    if (!(await deps.hasCapacity())) return { status: 'failed', error: TASK_LIMIT_MESSAGE };

    const competitorChanges = readable.map(({ url, page }) => ({
        url,
        changes: input.previousPages[url] ? describeChanges(diffSitePages(input.previousPages[url], page)) : [],
    }));

    const lenses: Lens[] = readable.length ? ['clarity', 'compete', 'ai'] : ['clarity', 'ai'];
    const results = await Promise.all(lenses.map(async (lens) => {
        try {
            const prompt = buildLensPrompt(lens, input.brief, own.page,
                readable.map((r, i) => ({ page: r.page, changes: competitorChanges[i].changes })));
            const raw = parseModelJson<{ answers?: unknown; fixes?: unknown }>(
                await deps.callModel({ ...prompt, maxTokens: LENS_MAX_TOKENS }));
            if (!raw) return null;
            const a = sanitiseRubricAnswers(raw.answers, lens, own.page);
            const f = groundFixes(raw.fixes, lens, own.page);
            if (!a.answers.length) return null;   // a reply with no usable answer is a failed lens
            return { lens, answers: a.answers, fixes: f.fixes, dropped: a.dropped + f.dropped };
        } catch (err) {
            console.error('[site-audit] lens call failed', { lens, message: err instanceof Error ? err.message : String(err) });
            return null;
        }
    }));

    const answered = results.filter((r): r is NonNullable<typeof r> => r !== null);
    if (!answered.length) {
        return { status: 'failed', error: 'The review couldn\'t be completed this time — nothing was charged. Try again in a few minutes.' };
    }

    const answers: Partial<Record<Lens, RubricAnswer[]>> = {};
    for (const r of answered) answers[r.lens] = r.answers;
    const score = scoreAudit(own.page, readable.map((r) => r.page), answers);
    const fixes = answered.flatMap((r) => r.fixes);
    const groundingDropped = answered.reduce((n, r) => n + r.dropped, 0);

    const summaryInput = { brief: input.brief, score, previousScore: input.previousScore, fixes, competitorChanges };
    let summaryRaw: unknown = null;
    try {
        summaryRaw = parseModelJson(await deps.callModel({ ...buildSummaryPrompt(summaryInput), maxTokens: SUMMARY_MAX_TOKENS }));
    } catch (err) {
        console.error('[site-audit] summary call failed — using the plain summary', err instanceof Error ? err.message : err);
    }
    const summary = sanitiseSummary(summaryRaw, summaryInput);

    return {
        status: 'done',
        pages,
        hashes,
        score,
        fixes,
        groundingDropped,
        report: {
            ...summary,
            competitorChanges,
            competitorsUnread,
            partialLenses: lenses.filter((l) => !answers[l]),
        },
    };
}

/** Open or accepted fixes whose old text is gone from the page — the change landed. Pure. */
export function fixesNowDone(open: Array<{ id: number; beforeText: string }>, page: SitePage): number[] {
    if (page.thin) return [];   // a page we couldn't read proves nothing either way
    return open.filter((f) => !isGrounded(f.beforeText, page)).map((f) => f.id);
}

// ── Real dependencies ───────────────────────────────────────────────────────────────────────

/** Read and extract one page, politely and safely. Never throws. */
export async function fetchSitePageLive(url: string): Promise<FetchResult> {
    try {
        const u = new URL(url);
        if (!(await robotsAllows(u.host, u.pathname + u.search, CRAWLERS.mysteryShopper))) {
            return { ok: false, message: `${u.host} asks crawlers like ours not to read this page (robots.txt), so we didn't.` };
        }
        const res = await safeFetchText(url, {
            userAgent: CRAWLERS.mysteryShopper.userAgent, timeoutMs: FETCH_TIMEOUT_MS, maxBytes: FETCH_MAX_BYTES,
        });
        if (res.contentType && !/html|xml/i.test(res.contentType)) {
            return { ok: false, message: 'That link isn\'t a web page (it returned a file).' };
        }
        return { ok: true, page: extractSitePage(res.body, res.finalUrl) };
    } catch (err) {
        if (err instanceof SafeFetchError) return { ok: false, message: err.message };
        console.error('[site-audit] fetch failed', { url, message: err instanceof Error ? err.message : String(err) });
        return { ok: false, message: 'We couldn\'t reach that page just now.' };
    }
}

// ── Database layer ──────────────────────────────────────────────────────────────────────────

/**
 * Queue a run. At most one queued/running run per audit (partial unique index) — a second click
 * returns the run already in flight instead of starting a second paid one.
 */
export async function requestAuditRun(
    db: Db,
    opts: { auditId: number; organisationId: number; kind: AuditInput['kind']; userId: number | null },
): Promise<{ runId: number; alreadyRunning: boolean }> {
    const inserted = await db.execute<{ id: number }>(sql`
        INSERT INTO site_audit_runs (audit_id, organisation_id, requested_by, kind, status)
        VALUES (${opts.auditId}, ${opts.organisationId}, ${opts.userId}, ${opts.kind}, 'queued')
        ON CONFLICT (audit_id) WHERE status IN ('queued', 'running') AND audit_id IS NOT NULL DO NOTHING
        RETURNING id`);
    const row = (inserted as unknown as Array<{ id: number }>)[0];
    if (row) return { runId: Number(row.id), alreadyRunning: false };
    const [existing] = await db.select({ id: siteAuditRuns.id }).from(siteAuditRuns).where(and(
        eq(siteAuditRuns.auditId, opts.auditId), inArray(siteAuditRuns.status, ['queued', 'running']),
    )).limit(1);
    if (!existing) throw new Error('site audit run neither inserted nor found');
    return { runId: existing.id, alreadyRunning: true };
}

/** End runs that were queued or running too long (a lost wake-up, a killed worker). Free. */
export async function sweepStuckAuditRuns(db: Db, auditId: number): Promise<number> {
    const ended = await db.update(siteAuditRuns)
        .set({ status: 'failed', error: 'That check took too long and was stopped. Nothing was charged — try again.', finishedAt: new Date() })
        .where(and(
            eq(siteAuditRuns.auditId, auditId),
            inArray(siteAuditRuns.status, ['queued', 'running']),
            sql`${siteAuditRuns.createdAt} < now() - (${RUN_TIMEOUT_MS} * interval '1 millisecond')`,
        ))
        .returning({ id: siteAuditRuns.id });
    return ended.length;
}

/** End a run as failed, free. Used when the worker could not be woken. */
export async function failAuditRun(db: Db, runId: number, error: string): Promise<void> {
    await db.update(siteAuditRuns)
        .set({ status: 'failed', error, finishedAt: new Date() })
        .where(and(eq(siteAuditRuns.id, runId), inArray(siteAuditRuns.status, ['queued', 'running'])));
}

/**
 * The worker's whole job. Never throws: any fault ends the run as failed and free.
 * `emailTo` is the public taster's address — passed in, used once to send the result, never stored.
 */
export async function executeAuditRun(db: Db, runId: number, opts: { emailTo?: string | null } = {}): Promise<void> {
    // Claim: only a queued run, only once.
    const [claimed] = await db.update(siteAuditRuns)
        .set({ status: 'running', startedAt: new Date() })
        .where(and(eq(siteAuditRuns.id, runId), eq(siteAuditRuns.status, 'queued')))
        .returning();
    if (!claimed) return;
    if (claimed.kind === 'public_taster') { await executeTasterRun(db, claimed, opts.emailTo ?? null); return; }
    if (claimed.auditId === null || claimed.organisationId === null) return;
    const orgId = claimed.organisationId;

    try {
        const [audit] = await db.select().from(siteAudits).where(eq(siteAudits.id, claimed.auditId)).limit(1);
        if (!audit) { await failAuditRun(db, runId, 'This audit no longer exists.'); return; }
        const [assistant] = await db.select({ id: aiAssistants.id, name: aiAssistants.name, userId: aiAssistants.userId })
            .from(aiAssistants).where(eq(aiAssistants.id, audit.aiAssistantId)).limit(1);

        // The last read that has pages to compare against.
        const [prev] = await db.select({ pages: siteAuditRuns.pages }).from(siteAuditRuns).where(and(
            eq(siteAuditRuns.auditId, audit.id),
            inArray(siteAuditRuns.status, ['done', 'unchanged', 'unreadable']),
            sql`${siteAuditRuns.pages} IS NOT NULL`,
        )).orderBy(desc(siteAuditRuns.id)).limit(1);

        let productsBlock: string | null = null;
        try { productsBlock = await loadProductsBlock(db, orgId); } catch { /* no products is fine */ }
        // The user's Rules reach the rewrites (registry rulesScope 'audit' says so on the Rules tab).
        let rulesBlock: string | null = null;
        try { rulesBlock = await loadAssistantRulesBlock(db, { assistantId: audit.aiAssistantId, organisationId: orgId }); } catch { /* none */ }

        const kind = claimed.kind as AuditInput['kind'];
        const outcome = await runAuditCore({
            kind,
            brief: { url: audit.url, icp: audit.icp, conversionGoal: audit.conversionGoal, productsBlock, rulesBlock },
            competitorUrls: Array.isArray(audit.competitorUrls) ? (audit.competitorUrls as string[]) : [],
            lastHashes: (audit.lastHashes ?? {}) as Record<string, string>,
            previousPages: ((prev?.pages ?? {}) as Record<string, SitePage>),
            previousScore: audit.currentScore,
        }, {
            fetchPage: fetchSitePageLive,
            callModel: async (req) => (await gatewayGenerate({
                system: req.system,
                messages: [{ role: 'user', content: req.user }],
                maxTokens: req.maxTokens,
                usage: { workspaceId: orgId, assistantId: audit.aiAssistantId, userId: claimed.requestedBy },
            })).text,
            hasCapacity: () => hasTaskCapacity(db, orgId),
        });

        if (outcome.status === 'failed') {
            await failAuditRun(db, runId, outcome.error);
            return;
        }

        // Fixes from earlier runs whose old text has gone — verified by this read. Only fixes for THIS
        // page: a homepage fix is not "done" because its wording is absent from the pricing page.
        const open = await db.select({ id: siteAuditFixes.id, beforeText: siteAuditFixes.beforeText }).from(siteAuditFixes)
            .where(and(
                eq(siteAuditFixes.auditId, audit.id),
                inArray(siteAuditFixes.status, ['open', 'accepted']),
                sql`(${siteAuditFixes.pageUrl} IS NULL OR ${siteAuditFixes.pageUrl} = ${audit.url})`,
            ));
        const doneIds = fixesNowDone(open, outcome.pages[SITE_KEY]);
        if (doneIds.length) {
            await db.update(siteAuditFixes)
                .set({ status: 'done', verifiedRunId: runId, updatedAt: new Date() })
                .where(inArray(siteAuditFixes.id, doneIds));
        }

        if (outcome.status !== 'done') {
            await db.update(siteAuditRuns).set({
                status: outcome.status,
                overallScore: outcome.status === 'unchanged' ? audit.currentScore : null,
                pages: outcome.pages,
                finishedAt: new Date(),
            }).where(eq(siteAuditRuns.id, runId));
            await db.update(siteAudits).set({ lastHashes: outcome.hashes, lastRunId: runId, updatedAt: new Date() })
                .where(and(eq(siteAudits.id, audit.id), eq(siteAudits.url, audit.url)));
            return;
        }

        // Priorities become fix rows (the rest stay in the report for the record).
        const rows = outcome.report.priorities.map((p) => {
            const f = outcome.fixes[p.fix];
            return {
                auditId: audit.id, runId, organisationId: orgId, lens: f.lens, location: f.location || null,
                problem: f.problem, beforeText: f.currentText, afterText: f.suggestedText,
                whyItMatters: p.whyItMatters, impact: p.impact, pageUrl: audit.url,
            };
        });
        // Don't re-raise a fix that is already on the list with the same old text.
        const stillOpen = new Set(open.filter((o) => !doneIds.includes(o.id)).map((o) => normaliseText(o.beforeText)));
        const fresh = rows.filter((r) => !stillOpen.has(normaliseText(r.beforeText)));
        if (fresh.length) await db.insert(siteAuditFixes).values(fresh);

        // The success latch: done + charged in ONE update, only from 'running'.
        const [latched] = await db.update(siteAuditRuns).set({
            status: 'done',
            charged: true,
            overallScore: outcome.score.overall,
            scores: { overall: outcome.score.overall, lenses: outcome.score.lenses, outcomes: outcome.score.outcomes },
            pages: outcome.pages,
            changes: outcome.report.competitorChanges,
            report: { ...outcome.report, fixes: outcome.fixes },
            groundingDropped: outcome.groundingDropped,
            finishedAt: new Date(),
        }).where(and(eq(siteAuditRuns.id, runId), eq(siteAuditRuns.status, 'running'))).returning({ id: siteAuditRuns.id });
        if (!latched) return;   // swept as stuck meanwhile — not charged, not reported

        await recordCompletedWork(db, orgId, 'site_audit', 1, runId);

        // The goal (plan §4.5): reaching the target moves the audit to 'goal_met' — the weekly checks
        // carry on (defence), and the Website tab proposes the next page. Once, not every week.
        const reachedGoal = audit.status === 'active' && outcome.score.overall !== null && outcome.score.overall >= audit.targetScore;
        await db.update(siteAudits).set({
            currentScore: outcome.score.overall,
            baselineScore: audit.baselineScore ?? outcome.score.overall,
            lastHashes: outcome.hashes,
            lastRunId: runId,
            ...(reachedGoal ? { status: 'goal_met' } : {}),
            updatedAt: new Date(),
        // Only if the page is still the one this run read: settings may have moved the audit to a
        // new page mid-run, and this score belongs to the old one (site-audit-setup.ts upsertAudit).
        }).where(and(eq(siteAudits.id, audit.id), eq(siteAudits.url, audit.url)));

        if (!assistant) return;
        const notify = (key: string, context: Record<string, unknown>) => createNotification(db, key, {
            userId: assistant.userId,
            assistantId: assistant.id,
            // Explicit so the stored column is right without db/notifications-categorization.sql
            // having been re-applied; the DB trigger only stamps when this is NULL.
            category: 'state_change',
            context: { assistant: { name: assistant.name }, ...context },
            metadata: { assistantId: assistant.id, siteAuditRunId: runId },
        }).catch((err) => console.error(`[site-audit] ${key} notification failed`, err));
        const site = new URL(audit.url).host;

        // A competitor moved: its own alert, naming who and the first change, because "your score is
        // 64" does not tell anyone that a rival just added a guarantee.
        const moved = outcome.report.competitorChanges.filter((c) => c.changes.length);
        if (moved.length) {
            const first = moved[0];
            await notify('site_audit_competitor_change', {
                competitor: {
                    site: new URL(first.url).host,
                    change: first.changes[0],
                    more: moved.reduce((n, c) => n + c.changes.length, 0) > 1 ? 'More changes are listed on the Website tab.' : '',
                },
            });
        }
        if (reachedGoal) {
            await notify('site_audit_goal_met', { audit: { score: String(outcome.score.overall), target: String(audit.targetScore), site } });
        }
        // The plain "your check is ready" — not for a weekly check where only a competitor changed
        // (the alert above said what matters), and not on top of the goal notification.
        const ownSiteChanged = (audit.lastHashes as Record<string, string> | null)?.[SITE_KEY] !== outcome.hashes[SITE_KEY];
        if (!reachedGoal && (kind !== 'weekly' || ownSiteChanged)) {
            await createNotification(db, 'site_audit_ready', {
                userId: assistant.userId,
                assistantId: assistant.id,
                // Explicit so the stored column is right without db/notifications-categorization.sql
                // having been re-applied; the DB trigger only stamps when this is NULL.
                category: 'state_change',
                context: {
                    assistant: { name: assistant.name },
                    audit: { score: String(outcome.score.overall ?? '—'), site },
                },
                metadata: { assistantId: assistant.id, siteAuditRunId: runId },
            }).catch((err) => console.error('[site-audit] notification failed', err));
        }
    } catch (err) {
        console.error('[site-audit] run failed', { runId, message: err instanceof Error ? err.message : String(err) });
        await failAuditRun(db, runId, 'Something went wrong running this check. Nothing was charged — try again.').catch(() => {});
    }
}

// ── The public taster (docs/mystery-shopper-plan.md §4.7) ────────────────────────────────────

/**
 * One page, the first-impression lens only, no workspace: nothing is charged and no task is used —
 * the cost is bounded by the endpoint's limits and daily cap (site-audit-public.ts). Never throws.
 */
async function executeTasterRun(db: Db, run: typeof siteAuditRuns.$inferSelect, emailTo: string | null): Promise<void> {
    const url = (run.report as { url?: string } | null)?.url;
    try {
        if (!url) { await failAuditRun(db, run.id, 'No address to check.'); return; }
        const fetched = await fetchSitePageLive(url);
        if (!fetched.ok) { await failAuditRun(db, run.id, fetched.message); return; }

        let result: TasterResult | null;
        if (fetched.page.thin) {
            result = unreadableResult(url);
        } else {
            const prompt = buildLensPrompt('clarity', { url, icp: null, conversionGoal: null, productsBlock: null }, fetched.page);
            let reply: unknown = null;
            try {
                // No workspace: the gateway still records the call in the platform total.
                const res = await gatewayGenerate({ system: prompt.system, messages: [{ role: 'user', content: prompt.user }], maxTokens: LENS_MAX_TOKENS });
                reply = parseModelJson(res.text);
            } catch (err) {
                console.error('[site-taster] lens call failed', err instanceof Error ? err.message : err);
            }
            result = buildTasterResult(fetched.page, reply);
        }
        if (!result) { await failAuditRun(db, run.id, 'The check couldn\'t be completed just now. Please try again in a few minutes.'); return; }

        const [latched] = await db.update(siteAuditRuns).set({
            status: result.unreadable ? 'unreadable' : 'done',
            overallScore: result.score,
            report: { url, result },
            finishedAt: new Date(),
        }).where(and(eq(siteAuditRuns.id, run.id), eq(siteAuditRuns.status, 'running'))).returning({ id: siteAuditRuns.id });
        if (!latched || !emailTo) return;
        await sendTasterEmail(run.id, result, emailTo);
    } catch (err) {
        console.error('[site-taster] run failed', { runId: run.id, message: err instanceof Error ? err.message : String(err) });
        await failAuditRun(db, run.id, 'The check couldn\'t be completed just now. Please try again in a few minutes.').catch(() => {});
    }
}

/** The one email a taster sends: their result, to the address they typed, once. Never throws. */
export async function sendTasterEmail(runId: number, result: TasterResult, to: string): Promise<void> {
    const token = tasterToken(runId);
    const base = resolveBaseUrl();
    if (!token || !base) return;
    try {
        await sendTemplatedEmail({
            triggerKey: 'site_taster_result',
            to,
            vars: {
                site: { host: new URL(result.url).hostname.replace(/^www\./, ''), score: result.score === null ? 'no score' : `${result.score}/100` },
                link: { action_url: `${base}/mystery-shopper?r=${runId}&t=${token}` },
            },
        });
    } catch (err) {
        console.error('[site-taster] result email failed', err instanceof Error ? err.message : err);
    }
}
