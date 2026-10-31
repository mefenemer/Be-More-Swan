// src/utils/site-directory-store.ts — the site page directory in the database: which site to read,
// reading it (hosted: inline from the published definition; external: the worker
// site-directory-background.ts), the weekly dispatch, the owner's exclusions, and THE ONE LOADER every
// assistant's prompt reads (loadSiteDirectoryBlock). The pure work is site-directory.ts.
// docs/site-directory-plan.md.
//
// Every read is wrapped: a missing table (db/z-site-directory.sql not applied yet) or a failed read
// is "no directory" — a missing prompt block, never a failed chat turn or draft.
//
// Costs no task (owner, 2026-10-31, plan D6): no model call, nothing drafted. Do NOT add
// recordCompletedWork here — tests/site-directory.test.ts pins that.

import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, organisations, orgProducts, siteDirectories, siteDomains, sites } from '../../db/schema';
import { CRAWLERS } from '../lib/robots';
import { resolveBaseUrl } from './base-url';
import { safeFetchText } from './safe-fetch';
import {
    crawlSite, directoryGaps, entriesFromDefinition, MANUAL_COOLDOWN_MS, readExcluded, readPages,
    REFRESH_INTERVAL_MS, siteDirectoryPromptBlock, type DirectoryPage,
} from './site-directory';
import { fetchSiteHtml } from './site-fetch';
import { siteOrigin } from './site-hosting';
import { cleanImportUrl } from './site-import';
import { createPageRenderer } from './site-js-render';
import { maxPagesFor, publishedDefinition } from './site-published';
import type { SiteRow } from './site-store';

type Db = ReturnType<typeof getDb>;
export type SiteDirectoryRow = typeof siteDirectories.$inferSelect;

const PAGE_TIMEOUT_MS = 10_000;
const PAGE_MAX_BYTES = 2 * 1024 * 1024;
const RENDER_TIMEOUT_MS = 20_000;
/** A 'reading' row older than this is a worker that died — a new refresh may start. */
const STALE_READING_MS = 20 * 60_000;
/** Most refreshes started per daily tick; the rest stay due for tomorrow. */
export const DISPATCH_MAX_PER_TICK = 40;
const WORKING_STATES = ['ready_for_work', 'working'];

// ── Reading the stored directory ────────────────────────────────────────────────────────────────

export async function loadDirectoryRow(db: Db, organisationId: number): Promise<SiteDirectoryRow | null> {
    try {
        const [row] = await db.select().from(siteDirectories).where(eq(siteDirectories.organisationId, organisationId)).limit(1);
        return row ?? null;
    } catch (err) {
        console.error('[site-directory] read failed (is db/z-site-directory.sql applied?)', err instanceof Error ? err.message : err);
        return null;
    }
}

/** What the Business Information tab and the chat card see. */
export interface DirectoryView {
    status: 'none' | 'reading' | 'ready' | 'failed';
    source: 'hosted' | 'crawl' | null;
    sourceUrl: string | null;
    message: string | null;
    refreshedAt: string | null;
    nextRefreshAt: string | null;
    /** When "Re-read my site" may run again; null = now. */
    canRefreshAt: string | null;
    pages: Array<DirectoryPage & { excluded: boolean }>;
}

export function directoryView(row: SiteDirectoryRow | null, now = new Date()): DirectoryView {
    if (!row) return { status: 'none', source: null, sourceUrl: null, message: null, refreshedAt: null, nextRefreshAt: null, canRefreshAt: null, pages: [] };
    const excluded = new Set(readExcluded(row.excluded));
    const last = row.updatedAt ? new Date(row.updatedAt).getTime() : 0;
    const coolUntil = row.requestedBy != null || row.status === 'reading' ? last + MANUAL_COOLDOWN_MS : 0;
    return {
        status: row.status as DirectoryView['status'],
        source: row.source as DirectoryView['source'],
        sourceUrl: row.sourceUrl,
        message: row.message,
        refreshedAt: row.refreshedAt ? new Date(row.refreshedAt).toISOString() : null,
        nextRefreshAt: row.nextRefreshAt ? new Date(row.nextRefreshAt).toISOString() : null,
        canRefreshAt: coolUntil > now.getTime() ? new Date(coolUntil).toISOString() : null,
        pages: readPages(row.pages).map((p) => ({ ...p, excluded: excluded.has(p.path) })),
    };
}

/**
 * THE loader: the capped "YOUR WEBSITE'S PAGES" block for any prompt — chat (every route), social,
 * blog, email, lead outreach. Null when there is no directory. Never throws.
 */
export async function loadSiteDirectoryBlock(db: Db, organisationId: number): Promise<string | null> {
    try {
        const row = await loadDirectoryRow(db, organisationId);
        if (!row) return null;
        return siteDirectoryPromptBlock({ pages: readPages(row.pages), excluded: readExcluded(row.excluded) });
    } catch (err) {
        console.error('[site-directory] block failed (non-fatal)', err instanceof Error ? err.message : err);
        return null;
    }
}

/** For the Business Mentor: pages the site lacks, against Business Information. Never throws. */
export async function loadSiteDirectoryGaps(db: Db, organisationId: number): Promise<string[]> {
    try {
        const row = await loadDirectoryRow(db, organisationId);
        if (!row) return [];
        const excluded = new Set(readExcluded(row.excluded));
        const pages = readPages(row.pages).filter((p) => !excluded.has(p.path));
        const products = await db.select({ name: orgProducts.name }).from(orgProducts)
            .where(and(eq(orgProducts.organisationId, organisationId), eq(orgProducts.status, 'active')));
        return directoryGaps(pages, products.map((p) => p.name).filter(Boolean));
    } catch (err) {
        console.error('[site-directory] gaps failed (non-fatal)', err instanceof Error ? err.message : err);
        return [];
    }
}

// ── Which site ──────────────────────────────────────────────────────────────────────────────────

export type DirectorySource =
    | { kind: 'hosted'; site: SiteRow; origin: string }
    | { kind: 'crawl'; url: string };

/** The published Be More Swan site's public origin: its live custom domain, else its free address. */
async function hostedOrigin(db: Db, site: SiteRow): Promise<string | null> {
    try {
        const [d] = await db.select({ domain: siteDomains.domain }).from(siteDomains)
            .where(and(eq(siteDomains.siteId, site.id), eq(siteDomains.status, 'live'))).limit(1);
        if (d?.domain) return `https://${d.domain}`;
    } catch { /* site_domains not there — fall back to the free address */ }
    return site.slug ? siteOrigin(site.slug) : null;
}

/** A published hosted site wins (plan D2); else the website address in Business Information; else none. */
export async function resolveDirectorySource(db: Db, organisationId: number): Promise<DirectorySource | null> {
    const [site] = await db.select().from(sites)
        .where(and(eq(sites.organisationId, organisationId), eq(sites.status, 'published'))).limit(1);
    if (site && site.publishedVersion != null) {
        const origin = await hostedOrigin(db, site);
        if (origin) return { kind: 'hosted', site, origin };
    }
    const [org] = await db.select({ websiteUrl: organisations.websiteUrl }).from(organisations).where(eq(organisations.id, organisationId)).limit(1);
    const url = cleanImportUrl(org?.websiteUrl ?? '');
    return url ? { kind: 'crawl', url } : null;
}

// ── Saving ──────────────────────────────────────────────────────────────────────────────────────

async function saveReady(db: Db, organisationId: number, source: 'hosted' | 'crawl', sourceUrl: string, pages: DirectoryPage[], message: string | null): Promise<void> {
    const now = new Date();
    const values = { source, sourceUrl, status: 'ready', pages, message, refreshedAt: now, nextRefreshAt: new Date(now.getTime() + REFRESH_INTERVAL_MS), updatedAt: now };
    await db.insert(siteDirectories).values({ organisationId, ...values })
        .onConflictDoUpdate({ target: siteDirectories.organisationId, set: values });
}

/** A failed refresh keeps the last good pages; it only records why, and tries again next week. */
async function saveFailed(db: Db, organisationId: number, source: 'hosted' | 'crawl', sourceUrl: string, message: string): Promise<void> {
    const now = new Date();
    const set = { source, sourceUrl, status: 'failed', message, nextRefreshAt: new Date(now.getTime() + REFRESH_INTERVAL_MS), updatedAt: now };
    await db.insert(siteDirectories).values({ organisationId, ...set })
        .onConflictDoUpdate({ target: siteDirectories.organisationId, set });
}

/** Build a hosted site's directory from its published definition. No fetch. */
async function buildHosted(db: Db, src: Extract<DirectorySource, { kind: 'hosted' }>): Promise<DirectoryPage[] | null> {
    const def = await publishedDefinition(db, src.site, await maxPagesFor(db, src.site.organisationId));
    if (!def) return null;
    const products = await db.select({ id: orgProducts.id, name: orgProducts.name }).from(orgProducts)
        .where(eq(orgProducts.organisationId, src.site.organisationId));
    return entriesFromDefinition(def, src.origin, new Map(products.map((p) => [p.id, p.name])));
}

// ── Refreshing ──────────────────────────────────────────────────────────────────────────────────

/** Wake the worker for an external site. ⚠️ Awaited (memory: background-trigger-must-be-awaited). */
async function triggerDirectoryWorker(organisationId: number): Promise<boolean> {
    const secret = process.env.CRON_TRIGGER_SECRET;
    const baseUrl = resolveBaseUrl();
    if (!secret || !baseUrl) {
        console.error('[site-directory] worker NOT dispatched — ' + (!secret ? 'CRON_TRIGGER_SECRET unset' : 'base URL unresolved'), { organisationId });
        return false;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
        const res = await fetch(`${baseUrl}/.netlify/functions/site-directory-background`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
            body: JSON.stringify({ organisationId }),
            signal: controller.signal,
        });
        return res.status === 202 || res.ok;
    } catch (err) {
        console.error('[site-directory] dispatch failed', { organisationId, err: err instanceof Error ? err.message : err });
        return false;
    } finally {
        clearTimeout(timer);
    }
}

export type RefreshResult = { ok: true; view: DirectoryView } | { ok: false; status: number; error: string };

const NO_SITE = 'There\'s no website to read yet. Add your website address in Business Information ▸ Business Profile, or publish your Be More Swan site.';

/**
 * Re-read the site. `manual` (the "Re-read my site" button or the chat card) is limited to once an
 * hour. A hosted site is rebuilt inline; an external one is handed to the worker.
 */
export async function requestDirectoryRefresh(db: Db, organisationId: number, opts: { userId: number | null; manual: boolean; now?: Date }): Promise<RefreshResult> {
    const now = opts.now ?? new Date();
    const row = await loadDirectoryRow(db, organisationId);
    if (row?.status === 'reading' && now.getTime() - new Date(row.updatedAt).getTime() < STALE_READING_MS) {
        return { ok: false, status: 409, error: 'Your website is being read right now — it takes a minute or two.' };
    }
    if (opts.manual && row) {
        const until = directoryView(row, now).canRefreshAt;
        if (until) return { ok: false, status: 429, error: `Your site was read in the last hour. You can re-read it again after ${new Date(until).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' })}.` };
    }
    const src = await resolveDirectorySource(db, organisationId);
    if (!src) return { ok: false, status: 400, error: NO_SITE };
    try {
        if (src.kind === 'hosted') {
            const pages = await buildHosted(db, src);
            if (pages) await saveReady(db, organisationId, 'hosted', src.origin, pages, null);
            else await saveFailed(db, organisationId, 'hosted', src.origin, 'Your published site couldn\'t be read just now.');
            // Only a press of "Re-read my site" starts the hour's wait; the weekly read never does.
            await db.update(siteDirectories).set({ requestedBy: opts.manual ? opts.userId : null }).where(eq(siteDirectories.organisationId, organisationId));
        } else {
            const values = { source: 'crawl', sourceUrl: src.url, status: 'reading', message: null, requestedBy: opts.manual ? opts.userId : null, updatedAt: now };
            await db.insert(siteDirectories).values({ organisationId, ...values })
                .onConflictDoUpdate({ target: siteDirectories.organisationId, set: values });
            if (!(await triggerDirectoryWorker(organisationId))) {
                await saveFailed(db, organisationId, 'crawl', src.url, 'Reading your website couldn\'t be started. Try again in a few minutes.');
                return { ok: false, status: 503, error: 'Reading your website couldn\'t be started. Try again in a few minutes.' };
            }
        }
    } catch (err) {
        console.error('[site-directory] refresh failed', { organisationId, message: err instanceof Error ? err.message : String(err) });
        return { ok: false, status: 503, error: 'Your website pages aren\'t available just yet.' };
    }
    return { ok: true, view: directoryView(await loadDirectoryRow(db, organisationId), now) };
}

/** The worker's job (site-directory-background.ts): read an external site and save it. Never throws. */
export async function runDirectoryRefresh(db: Db, organisationId: number): Promise<void> {
    let src: DirectorySource | null = null;
    try {
        src = await resolveDirectorySource(db, organisationId);
        if (!src) return;
        if (src.kind === 'hosted') {
            const pages = await buildHosted(db, src);
            if (pages) await saveReady(db, organisationId, 'hosted', src.origin, pages, null);
            return;
        }
        const renderer = createPageRenderer(CRAWLERS.siteDirectory, { timeoutMs: RENDER_TIMEOUT_MS, maxBytes: PAGE_MAX_BYTES });
        try {
            const result = await crawlSite(src.url, {
                fetchHtml: (url) => fetchSiteHtml(url, CRAWLERS.siteDirectory, { timeoutMs: PAGE_TIMEOUT_MS, maxBytes: PAGE_MAX_BYTES }),
                fetchText: async (url) => (await safeFetchText(url, { userAgent: CRAWLERS.siteDirectory.userAgent, timeoutMs: 3_000, maxBytes: 64 * 1024 })).body,
                renderHtml: (url) => renderer.render(url),
            });
            if (result.ok) {
                const note = result.skipped ? `${result.skipped} page${result.skipped === 1 ? '' : 's'} couldn't be read and ${result.skipped === 1 ? 'was' : 'were'} left out.` : null;
                await saveReady(db, organisationId, 'crawl', src.url, result.pages, note);
            } else {
                await saveFailed(db, organisationId, 'crawl', src.url, result.message);
            }
        } finally {
            await renderer.close().catch(() => {});
        }
    } catch (err) {
        console.error('[site-directory] worker failed', { organisationId, message: err instanceof Error ? err.message : String(err) });
        if (src) await saveFailed(db, organisationId, src.kind, src.kind === 'hosted' ? src.origin : src.url, 'We couldn\'t read your website this time. It will be tried again next week.').catch(() => {});
    }
}

/** After a hosted site publishes: rebuild at once (no fetch, no cost). Never throws. */
export async function refreshDirectoryAfterPublish(db: Db, organisationId: number): Promise<void> {
    try {
        const src = await resolveDirectorySource(db, organisationId);
        if (src?.kind === 'hosted') {
            const pages = await buildHosted(db, src);
            if (pages) await saveReady(db, organisationId, 'hosted', src.origin, pages, null);
        }
    } catch (err) {
        console.error('[site-directory] refresh after publish failed (non-fatal)', err instanceof Error ? err.message : err);
    }
}

/** After the website address changes in Business Information. Never throws. */
export async function refreshDirectoryAfterAddressChange(db: Db, organisationId: number): Promise<void> {
    try {
        await requestDirectoryRefresh(db, organisationId, { userId: null, manual: false });
    } catch (err) {
        console.error('[site-directory] refresh after address change failed (non-fatal)', err instanceof Error ? err.message : err);
    }
}

// ── The owner's choices ─────────────────────────────────────────────────────────────────────────

/** Leave a page out of every assistant's view, or put it back. Survives refreshes. */
export async function setDirectoryPageExcluded(db: Db, organisationId: number, path: string, excluded: boolean): Promise<RefreshResult> {
    const row = await loadDirectoryRow(db, organisationId);
    if (!row) return { ok: false, status: 404, error: 'Your website hasn\'t been read yet.' };
    const list = new Set(readExcluded(row.excluded));
    if (excluded) list.add(path); else list.delete(path);
    await db.update(siteDirectories).set({ excluded: [...list].slice(0, 200) }).where(eq(siteDirectories.organisationId, organisationId));
    return { ok: true, view: directoryView(await loadDirectoryRow(db, organisationId)) };
}

// ── The weekly refresh ──────────────────────────────────────────────────────────────────────────

export interface DirectoryDispatchResult { considered: number; started: number; failedToStart: number; deferred: number; noSite: number; }

/**
 * Daily: refresh every workspace with a working assistant whose directory is due (never read, or a
 * week since). At most DISPATCH_MAX_PER_TICK a tick — which also spreads the first build over days.
 */
export async function dispatchDueDirectories(db: Db, now = new Date()): Promise<DirectoryDispatchResult> {
    const rows = await db.selectDistinct({ organisationId: aiAssistants.organisationId }).from(aiAssistants)
        .leftJoin(siteDirectories, eq(siteDirectories.organisationId, aiAssistants.organisationId))
        .where(and(
            eq(aiAssistants.isActive, true),
            inArray(aiAssistants.lifecycleStatus, WORKING_STATES),
            or(isNull(siteDirectories.id), lte(siteDirectories.nextRefreshAt, now), isNull(siteDirectories.nextRefreshAt)),
            sql`${aiAssistants.organisationId} IS NOT NULL`,
        ));
    const out: DirectoryDispatchResult = { considered: rows.length, started: 0, failedToStart: 0, deferred: 0, noSite: 0 };
    for (const r of rows) {
        if (r.organisationId == null) continue;
        if (out.started >= DISPATCH_MAX_PER_TICK) { out.deferred++; continue; }
        const res = await requestDirectoryRefresh(db, r.organisationId, { userId: null, manual: false, now }).catch(() => null);
        if (res?.ok) out.started++;
        else if (res && res.status === 400) out.noSite++;
        else if (res?.status !== 409) out.failedToStart++;
    }
    return out;
}
