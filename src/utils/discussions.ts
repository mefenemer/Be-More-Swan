// src/utils/discussions.ts
// The Lead Generator's Discussions tab — the one server path behind the tab's buttons, the chat's
// discussion card, the daily scan and "Scan now". netlify/functions/discussions.ts (the tenant API)
// and run-discussion-scan-background.ts (the worker) only call in here.
//
// ── What a scan does ─────────────────────────────────────────────────────────────────────────────
//  1. One Google search (Serper) per topic × watched site, restricted to the last week.
//  2. Keep results that are on that site, look like a thread, are recent, and are not already a row.
//  3. Read each thread page where its robots.txt lets us (Reddit's does not: snippet only).
//  4. The model judges relevance and drafts a reply (src/lib/discussion-triage.ts).
//  5. Keep what scored MIN_RELEVANCE or more, with the disclosure line added in code.
// A scan is ONE task (`lead_search` — it is a search for prospects), asked before and counted after,
// like every other piece of background work (src/utils/work-metering.ts).
//
// ── What it never does ───────────────────────────────────────────────────────────────────────────
// Post, comment, vote or message anywhere. The card's buttons copy the reply and open the thread;
// the person posts it themselves. See src/config/discussion-sites.ts for why that is the design.

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import * as cheerio from 'cheerio';
import type { getDb } from '../../db/client';
import { aiAssistants, discussions, discussionWatches } from '../../db/schema';
import {
    DAILY_SCAN_MIN_GAP_MS, DEFAULT_DISCUSSION_SITES, DISCUSSION_FIT_LABELS, DISCUSSION_SITES,
    MAX_THREAD_AGE_DAYS, MAX_TRIAGE_PER_SCAN, MIN_RELEVANCE, RESULTS_PER_SEARCH, SCAN_STALE_MS,
    discussionQuery, isDiscussionSite, looksLikeThread, normaliseSites, normaliseThreadUrl,
    normaliseTopics, postedAgeDays, siteForUrl, withDisclosure,
    type DiscussionFit, type DiscussionSiteKey, type DiscussionStatus,
} from '../config/discussion-sites';
import { isSearchConfigured, search } from '../lib/discovery-search';
import { THREAD_TEXT_CHARS, redraftReply, triageThreads, type TriageCandidate } from '../lib/discussion-triage';
import { robotsAllows, CRAWLERS } from '../lib/robots';
import { safeFetchText } from './safe-fetch';
import { loadSenderIdentity } from './sender-identity';
import { loadRoleModel, roleKeyOfAssistant } from './assistant-model';
import { hasTaskCapacity, recordCompletedWork, TASK_LIMIT_MESSAGE } from './work-metering';
import { resolveBaseUrl } from './base-url';

type Db = ReturnType<typeof getDb>;

const WORKING_STATES = ['ready_for_work', 'working'];
const PAGE_FETCH_MS = 5000;
const PAGE_MAX_BYTES = 400_000;
/** At most this many watches started per daily tick; the rest go next tick. */
const MAX_DISPATCH_PER_TICK = 100;

// ── Watch ────────────────────────────────────────────────────────────────────────────────────────

export interface WatchView {
    topics: string[];
    sites: DiscussionSiteKey[];
    enabled: boolean;
    scanning: boolean;
    lastScannedAt: string | null;
    lastScan: { searches?: number; found?: number; kept?: number; error?: string } | null;
}

type WatchRow = typeof discussionWatches.$inferSelect;

function toIso(v: Date | string | null | undefined): string | null {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(String(v).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(v)) ? '' : 'Z'));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function isStale(row: WatchRow): boolean {
    const started = toIso(row.scanStartedAt);
    return !started || Date.now() - Date.parse(started) > SCAN_STALE_MS;
}

export function watchView(row: WatchRow | null): WatchView {
    if (!row) return { topics: [], sites: [...DEFAULT_DISCUSSION_SITES], enabled: true, scanning: false, lastScannedAt: null, lastScan: null };
    return {
        topics: row.topics ?? [],
        sites: normaliseSites(row.sites),
        enabled: row.enabled,
        scanning: row.scanStatus === 'running' && !isStale(row),
        lastScannedAt: toIso(row.lastScannedAt),
        lastScan: (row.lastScan && typeof row.lastScan === 'object') ? row.lastScan as WatchView['lastScan'] : null,
    };
}

export async function loadWatch(db: Db, organisationId: number, assistantId: number): Promise<WatchRow | null> {
    const [row] = await db.select().from(discussionWatches)
        .where(and(eq(discussionWatches.organisationId, organisationId), eq(discussionWatches.aiAssistantId, assistantId)))
        .limit(1);
    return row ?? null;
}

/** Save what the watch looks for. Topics and sites are cleaned here — the one place either is written. */
export async function saveWatch(
    db: Db, organisationId: number, assistantId: number,
    input: { topics?: unknown; sites?: unknown; enabled?: unknown },
): Promise<WatchView> {
    const existing = await loadWatch(db, organisationId, assistantId);
    const topics = input.topics !== undefined ? normaliseTopics(input.topics) : existing?.topics ?? [];
    const sites = input.sites !== undefined ? normaliseSites(input.sites) : existing ? normaliseSites(existing.sites) : [...DEFAULT_DISCUSSION_SITES];
    const enabled = typeof input.enabled === 'boolean' ? input.enabled : existing?.enabled ?? true;
    const [row] = await db.insert(discussionWatches)
        .values({ organisationId, aiAssistantId: assistantId, topics, sites, enabled })
        .onConflictDoUpdate({
            target: discussionWatches.aiAssistantId,
            set: { topics, sites, enabled, updatedAt: sql`now()` },
        })
        .returning();
    return watchView(row);
}

// ── Starting a scan ──────────────────────────────────────────────────────────────────────────────

/** Take the watch for one scan. False when one is already running (and not stale). */
async function claimScan(db: Db, watchId: number): Promise<boolean> {
    const rows = await db.update(discussionWatches)
        .set({ scanStatus: 'running', scanStartedAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(
            eq(discussionWatches.id, watchId),
            sql`(${discussionWatches.scanStatus} = 'idle' OR ${discussionWatches.scanStartedAt} IS NULL OR ${discussionWatches.scanStartedAt} < now() - make_interval(secs => ${SCAN_STALE_MS / 1000}))`,
        ))
        .returning({ id: discussionWatches.id });
    return rows.length > 0;
}

async function releaseScan(db: Db, watchId: number, lastScan: Record<string, unknown>, scanned: boolean): Promise<void> {
    await db.update(discussionWatches)
        .set({
            scanStatus: 'idle', scanStartedAt: null, lastScan, updatedAt: sql`now()`,
            ...(scanned ? { lastScannedAt: sql`now()` } : {}),
        })
        .where(eq(discussionWatches.id, watchId));
}

/** Wake the background worker. Mirrors trigger-site-audit.ts. */
async function triggerScanWorker(watchId: number): Promise<boolean> {
    const secret = process.env.CRON_TRIGGER_SECRET;
    const baseUrl = resolveBaseUrl();
    if (!secret || !baseUrl) {
        console.error('[discussions] scan NOT dispatched — ' + (!secret ? 'CRON_TRIGGER_SECRET unset' : 'base URL unresolved'), { watchId });
        return false;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
        const res = await fetch(`${baseUrl}/.netlify/functions/run-discussion-scan-background`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
            body: JSON.stringify({ watchId }),
            signal: controller.signal,
        });
        return res.status === 202 || res.ok;
    } catch (err) {
        console.error('[discussions] scan dispatch failed', { watchId, err: err instanceof Error ? err.message : err });
        return false;
    } finally {
        clearTimeout(timer);
    }
}

export type StartScanResult =
    | { ok: true; watch: WatchView }
    | { ok: false; code: 'no_topics' | 'no_sites' | 'already_running' | 'no_capacity' | 'not_configured' | 'not_started'; error: string };

/** "Scan now" (the tab's button, and the chat card's). Claims the watch and wakes the worker. */
export async function startScan(db: Db, organisationId: number, assistantId: number): Promise<StartScanResult> {
    const watch = await loadWatch(db, organisationId, assistantId);
    if (!watch || !watch.topics.length) return { ok: false, code: 'no_topics', error: 'Add at least one topic to look for first.' };
    if (!normaliseSites(watch.sites).length) return { ok: false, code: 'no_sites', error: 'Choose at least one site to watch first.' };
    if (!isSearchConfigured()) return { ok: false, code: 'not_configured', error: 'Searching isn’t set up on this server yet.' };
    if (!(await hasTaskCapacity(db, organisationId))) return { ok: false, code: 'no_capacity', error: TASK_LIMIT_MESSAGE };
    if (!(await claimScan(db, watch.id))) return { ok: false, code: 'already_running', error: 'A scan is already running — it usually takes a minute or two.' };
    if (!(await triggerScanWorker(watch.id))) {
        await releaseScan(db, watch.id, { error: 'The scan couldn’t be started. Nothing was charged — please try again.' }, false);
        return { ok: false, code: 'not_started', error: 'The scan couldn’t be started. Nothing was charged — please try again in a moment.' };
    }
    const fresh = await loadWatch(db, organisationId, assistantId);
    return { ok: true, watch: watchView(fresh) };
}

export interface DispatchResult { considered: number; queued: number; alreadyRunning: number; failedToStart: number; deferred: number }

/** The daily scan: every enabled watch with topics, on a working assistant, not scanned today. */
export async function dispatchDueScans(db: Db): Promise<DispatchResult> {
    const rows = await db.select({ id: discussionWatches.id, organisationId: discussionWatches.organisationId, topics: discussionWatches.topics, sites: discussionWatches.sites })
        .from(discussionWatches)
        .innerJoin(aiAssistants, eq(aiAssistants.id, discussionWatches.aiAssistantId))
        .where(and(
            eq(discussionWatches.enabled, true),
            eq(aiAssistants.isActive, true),
            inArray(aiAssistants.lifecycleStatus, WORKING_STATES),
            sql`cardinality(${discussionWatches.topics}) > 0`,
            sql`(${discussionWatches.lastScannedAt} IS NULL OR ${discussionWatches.lastScannedAt} < now() - make_interval(secs => ${DAILY_SCAN_MIN_GAP_MS / 1000}))`,
        ));
    const out: DispatchResult = { considered: rows.length, queued: 0, alreadyRunning: 0, failedToStart: 0, deferred: 0 };
    if (!isSearchConfigured()) { out.failedToStart = rows.length; return out; }
    for (const r of rows) {
        if (!normaliseSites(r.sites).length) continue;
        if (out.queued >= MAX_DISPATCH_PER_TICK) { out.deferred++; continue; }
        // Out of tasks = not started, not charged; tomorrow's tick tries again.
        if (!(await hasTaskCapacity(db, r.organisationId))) { out.deferred++; continue; }
        if (!(await claimScan(db, r.id))) { out.alreadyRunning++; continue; }
        if (await triggerScanWorker(r.id)) out.queued++;
        else {
            out.failedToStart++;
            await releaseScan(db, r.id, { error: 'Today’s scan couldn’t be started. It will be tried again tomorrow — nothing was charged.' }, false);
        }
    }
    return out;
}

// ── Running a scan (the worker) ──────────────────────────────────────────────────────────────────

/** A thread's visible text, where its robots.txt lets us read it. '' otherwise. Never throws. */
async function readThread(url: string): Promise<string> {
    try {
        const u = new URL(url);
        if (!(await robotsAllows(u.hostname, u.pathname, CRAWLERS.leadDiscovery))) return '';
        const { body } = await safeFetchText(url, { timeoutMs: PAGE_FETCH_MS, maxBytes: PAGE_MAX_BYTES, userAgent: CRAWLERS.leadDiscovery.userAgent });
        const $ = cheerio.load(body);
        $('script, style, noscript, svg, nav, header, footer').remove();
        return $('body').text().replace(/\s+/g, ' ').trim().slice(0, THREAD_TEXT_CHARS);
    } catch {
        return '';
    }
}

interface Candidate { site: DiscussionSiteKey; url: string; title: string; snippet: string; postedLabel: string | null; topic: string }

/**
 * Run one claimed scan to the end. Never throws; always releases the watch. Called only by
 * run-discussion-scan-background.ts, after startScan / dispatchDueScans has claimed it.
 */
export async function runScan(db: Db, watchId: number): Promise<void> {
    const [watch] = await db.select().from(discussionWatches).where(eq(discussionWatches.id, watchId)).limit(1);
    if (!watch) return;
    const orgId = watch.organisationId;
    const assistantId = watch.aiAssistantId;
    const sites = normaliseSites(watch.sites);
    const topics = normaliseTopics(watch.topics);
    const summary: Record<string, unknown> = { searches: 0, found: 0, kept: 0 };
    let scanned = false;
    try {
        if (!topics.length || !sites.length) { summary.error = 'Nothing to look for — add a topic and a site.'; return; }
        // Asked again here: the claim and the run can be a day apart under the daily tick.
        if (!(await hasTaskCapacity(db, orgId))) { summary.error = TASK_LIMIT_MESSAGE; return; }

        // 1. Search. Each topic × site, all at once; one failed search loses only its own results.
        const pairs = topics.flatMap((topic) => sites.map((site) => ({ topic, site })));
        const searches = await Promise.all(pairs.map(async ({ topic, site }) => {
            try {
                const r = await search(discussionQuery(topic, site), { limit: RESULTS_PER_SEARCH, recency: 'week', usage: { workspaceId: orgId, assistantId } });
                return { topic, site, results: r.results };
            } catch (err) {
                console.error('[discussions] search failed', { watchId, site, message: err instanceof Error ? err.message : String(err) });
                return { topic, site, results: [] };
            }
        }));
        summary.searches = pairs.length;

        // 2. Filter and dedupe — within this scan, then against every thread already filed.
        const byUrl = new Map<string, Candidate>();
        for (const s of searches) {
            for (const r of s.results) {
                const url = normaliseThreadUrl(r.url);
                if (!url) continue;
                const site = siteForUrl(url, [s.site]);
                if (!site || !looksLikeThread(url, site)) continue;
                const age = postedAgeDays(r.date);
                if (age !== null && age > MAX_THREAD_AGE_DAYS) continue;
                if (!byUrl.has(url)) byUrl.set(url, { site, url, title: r.title || url, snippet: r.snippet || '', postedLabel: r.date ?? null, topic: s.topic });
            }
        }
        summary.found = byUrl.size;
        if (byUrl.size) {
            const known = await db.select({ url: discussions.url }).from(discussions)
                .where(and(eq(discussions.aiAssistantId, assistantId), inArray(discussions.url, [...byUrl.keys()])));
            for (const k of known) byUrl.delete(k.url);
        }
        const fresh = [...byUrl.values()].slice(0, MAX_TRIAGE_PER_SCAN);
        summary.new = fresh.length;

        if (fresh.length) {
            // 3. Read what we may. 4. Judge.
            const pages = await Promise.all(fresh.map((c) => readThread(c.url)));
            const [sender, roleKey] = await Promise.all([
                loadSenderIdentity(db, orgId, assistantId),
                roleKeyOfAssistant(db, assistantId),
            ]);
            const modelChoice = await loadRoleModel(db, roleKey ?? 'lead_qualifier');
            const candidates: TriageCandidate[] = fresh.map((c, i) => ({ site: c.site, title: c.title, snippet: c.snippet, pageText: pages[i] }));
            const triage = await triageThreads(candidates, sender, modelChoice, { workspaceId: orgId, assistantId });
            const judged = triage.verdicts.filter(Boolean).length;
            if (!judged) { summary.error = 'The threads couldn’t be read this time. Nothing was charged — the next scan will try again.'; return; }

            // 5. Keep the fits.
            const keep = fresh.flatMap((c, i) => {
                const v = triage.verdicts[i];
                if (!v || v.relevance < MIN_RELEVANCE || !v.reply) return [];
                return [{
                    organisationId: orgId, aiAssistantId: assistantId, site: c.site, url: c.url,
                    title: c.title.slice(0, 300), snippet: c.snippet.slice(0, 600) || null,
                    postedLabel: c.postedLabel, matchedTopic: c.topic, relevance: v.relevance, fit: v.fit,
                    why: v.why || null, draftReply: withDisclosure(v.reply, sender.businessName),
                    readFrom: pages[i] ? 'page' : 'snippet',
                }];
            });
            if (keep.length) {
                const inserted = await db.insert(discussions).values(keep).onConflictDoNothing().returning({ id: discussions.id });
                summary.kept = inserted.length;
            }
        }
        scanned = true;
        // Counted only once the scan has done its work — a failed scan costs nothing.
        await recordCompletedWork(db, orgId, 'lead_search', { assistantId, ref: `discussions:${watchId}` });
    } catch (err) {
        console.error('[discussions] scan failed', { watchId, message: err instanceof Error ? err.message : String(err) });
        summary.error = 'The scan stopped partway. Nothing was charged — the next scan will try again.';
    } finally {
        try { await releaseScan(db, watchId, summary, scanned); } catch (err) { console.error('[discussions] release failed', { watchId, err }); }
    }
}

// ── Reading and deciding ─────────────────────────────────────────────────────────────────────────

export interface DiscussionView {
    id: number;
    site: DiscussionSiteKey;
    siteLabel: string;
    promotionNote: string;
    url: string;
    title: string;
    snippet: string | null;
    postedLabel: string | null;
    matchedTopic: string | null;
    relevance: number;
    fit: DiscussionFit;
    fitLabel: string;
    why: string | null;
    draftReply: string | null;
    readFrom: 'page' | 'snippet';
    status: DiscussionStatus;
    foundAt: string | null;
    decidedAt: string | null;
}

type DiscussionRow = typeof discussions.$inferSelect;

export function discussionView(r: DiscussionRow): DiscussionView {
    const site = isDiscussionSite(r.site) ? r.site : 'reddit';
    const fit = (r.fit === 'asking_for' ? 'asking_for' : 'can_help') as DiscussionFit;
    return {
        id: r.id, site, siteLabel: DISCUSSION_SITES[site].label, promotionNote: DISCUSSION_SITES[site].promotionNote,
        url: r.url, title: r.title, snippet: r.snippet, postedLabel: r.postedLabel, matchedTopic: r.matchedTopic,
        relevance: r.relevance, fit, fitLabel: DISCUSSION_FIT_LABELS[fit], why: r.why, draftReply: r.draftReply,
        readFrom: r.readFrom === 'page' ? 'page' : 'snippet',
        status: (['new', 'replied', 'dismissed'].includes(r.status) ? r.status : 'new') as DiscussionStatus,
        foundAt: toIso(r.createdAt), decidedAt: toIso(r.decidedAt),
    };
}

export const LIST_PAGE_SIZE = 200;

export async function listDiscussions(db: Db, organisationId: number, assistantId: number) {
    const [rows, counts, watch] = await Promise.all([
        db.select().from(discussions)
            .where(and(eq(discussions.organisationId, organisationId), eq(discussions.aiAssistantId, assistantId)))
            .orderBy(desc(discussions.createdAt)).limit(LIST_PAGE_SIZE),
        db.select({ status: discussions.status, n: sql<number>`count(*)::int` }).from(discussions)
            .where(and(eq(discussions.organisationId, organisationId), eq(discussions.aiAssistantId, assistantId)))
            .groupBy(discussions.status),
        loadWatch(db, organisationId, assistantId),
    ]);
    const c = { new: 0, replied: 0, dismissed: 0 };
    for (const r of counts) if (r.status in c) c[r.status as keyof typeof c] = Number(r.n);
    return { discussions: rows.map(discussionView), counts: c, watch: watchView(watch) };
}

export async function loadDiscussion(db: Db, organisationId: number, assistantId: number, id: number): Promise<DiscussionRow | null> {
    const [row] = await db.select().from(discussions)
        .where(and(eq(discussions.id, id), eq(discussions.organisationId, organisationId), eq(discussions.aiAssistantId, assistantId)))
        .limit(1);
    return row ?? null;
}

/** Mark replied / dismiss / put back to new. The one writer of `status`. */
export async function setDiscussionStatus(
    db: Db, organisationId: number, assistantId: number, id: number, status: DiscussionStatus, userId: number | null,
): Promise<DiscussionView | null> {
    const [row] = await db.update(discussions)
        .set({
            status, updatedAt: sql`now()`,
            decidedBy: status === 'new' ? null : userId,
            decidedAt: status === 'new' ? null : sql`now()`,
        })
        .where(and(eq(discussions.id, id), eq(discussions.organisationId, organisationId), eq(discussions.aiAssistantId, assistantId)))
        .returning();
    return row ? discussionView(row) : null;
}

/** The user's own edit of a draft. Saved as typed — the tab warns if the disclosure line is gone. */
export async function saveDraft(db: Db, organisationId: number, assistantId: number, id: number, text: string): Promise<DiscussionView | null> {
    const draft = text.replace(/\r\n/g, '\n').trim().slice(0, 4000);
    if (!draft) return null;
    const [row] = await db.update(discussions)
        .set({ draftReply: draft, updatedAt: sql`now()` })
        .where(and(eq(discussions.id, id), eq(discussions.organisationId, organisationId), eq(discussions.aiAssistantId, assistantId)))
        .returning();
    return row ? discussionView(row) : null;
}

/** "Redraft" — the model rewrites the reply, optionally to an instruction. Disclosure re-added in code. */
export async function redraftDiscussion(
    db: Db, organisationId: number, assistantId: number, id: number, instruction: string | null,
): Promise<{ ok: true; discussion: DiscussionView } | { ok: false; error: string }> {
    const row = await loadDiscussion(db, organisationId, assistantId, id);
    if (!row) return { ok: false, error: 'That thread isn’t in this assistant’s Discussions.' };
    const site = isDiscussionSite(row.site) ? row.site : 'reddit';
    const [sender, pageText] = await Promise.all([
        loadSenderIdentity(db, organisationId, assistantId),
        readThread(row.url),
    ]);
    const modelChoice = await loadRoleModel(db, (await roleKeyOfAssistant(db, assistantId)) ?? 'lead_qualifier');
    const reply = await redraftReply(
        { site, title: row.title, snippet: row.snippet ?? '', pageText, currentReply: row.draftReply },
        instruction ? instruction.trim().slice(0, 600) : null, sender, modelChoice, { workspaceId: organisationId, assistantId },
    );
    if (!reply) return { ok: false, error: 'The reply couldn’t be rewritten just now — please try again.' };
    const [updated] = await db.update(discussions)
        .set({ draftReply: withDisclosure(reply, sender.businessName), readFrom: pageText ? 'page' : row.readFrom, updatedAt: sql`now()` })
        .where(eq(discussions.id, row.id))
        .returning();
    return { ok: true, discussion: discussionView(updated) };
}

// ── Chat ─────────────────────────────────────────────────────────────────────────────────────────

/** How many new threads the chat sees by name. The block says when there are more. */
export const CHAT_SNAPSHOT_THREADS = 10;

/**
 * What the Lead Generator's chat knows about its Discussions tab, per turn, and the card it may
 * propose. Null when the tables are missing or the read failed — the prompt then says nothing
 * rather than something false.
 */
export async function buildDiscussionsChatBlock(db: Db, organisationId: number, assistantId: number): Promise<string | null> {
    try {
        const { discussions: rows, counts, watch } = await listDiscussions(db, organisationId, assistantId);
        const fresh = rows.filter((r) => r.status === 'new').slice(0, CHAT_SNAPSHOT_THREADS);
        const siteLabels = watch.sites.map((s) => DISCUSSION_SITES[s].label).join(', ') || 'none';
        const lines = fresh.map((r) => `#${r.id} · ${r.siteLabel} · relevance ${r.relevance} · ${r.fitLabel} · "${r.title.replace(/\s+/g, ' ').slice(0, 120)}"`);
        return `YOUR DISCUSSIONS TAB — public forum threads (${Object.values(DISCUSSION_SITES).map((s) => s.label).join(', ')}) where someone is asking for what this business sells, each with a reply you drafted. You only LISTEN: nothing is ever posted for the user. On each thread the user presses "Copy reply & open thread", pastes the reply and posts it from their own account, then presses "Mark replied". Every draft ends with a disclosure line ("Full disclosure: I work at …"), added automatically — never tell the user to remove it: posting a recommendation without saying it is from the business breaks the sites' rules and UK consumer law.
What it watches: topics ${watch.topics.length ? watch.topics.map((t) => `"${t}"`).join(', ') : '(none yet — nothing is scanned until there is at least one)'}; sites ${siteLabels}; daily scan ${watch.enabled ? 'on' : 'off'}${watch.scanning ? '; a scan is running now' : ''}${watch.lastScannedAt ? `; last scanned ${watch.lastScannedAt.slice(0, 10)}` : '; never scanned'}.
Threads: ${counts.new} new, ${counts.replied} replied, ${counts.dismissed} dismissed.${fresh.length ? `\nNew threads${counts.new > fresh.length ? ` (the ${fresh.length} most recent of ${counts.new})` : ''}:\n${lines.join('\n')}` : ''}

To act on the Discussions tab, emit a discussion_action_proposal uiElement — the user confirms on the card, and only their click changes anything:
{ "type": "discussion_action_proposal", "action": "set_watch" | "scan_now" | "redraft" | "mark_replied" | "dismiss",
  "topics": ["<phrase someone would search or post, e.g. 'recommend a bookkeeper for a small cafe'>", ...],   // set_watch only, at most 5; the WHOLE list
  "sites": ["reddit" | "ukbf" | "quora" | "linkedin", ...],   // set_watch only; omit to keep the current sites
  "enabled": true | false,                                   // set_watch only; the daily scan
  "discussionId": <the number after # above>,                 // redraft / mark_replied / dismiss
  "instruction": "<what to change, in the user's words>" | null }   // redraft only
Suggest topics written the way a customer would ask for help, from what this business sells — not the business's own name. A scan costs one task. Never write a reply to a thread in your own message: the card shows the stored draft, and "redraft" rewrites it. Never say a reply HAS been posted — only the user posts. The card does nothing until the user presses its button, so your message must NOT say you are scanning, have started a scan, have saved the topics, or have changed anything — say the card is there for them to confirm (e.g. "Press Scan now on the card below and I'll look").`;
    } catch (err) {
        console.error('[discussions] chat block failed', err instanceof Error ? err.message : err);
        return null;
    }
}
