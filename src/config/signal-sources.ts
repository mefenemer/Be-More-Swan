// src/config/signal-sources.ts
// The Signal Inbox's wire contract — the single definition of what a "signal" is, shared by
// netlify/functions/signal-inbox.ts and src/components/assistant-signal-inbox.js.
//
// Design: docs/lead-generator-revenue-engine-plan.md §4 (Phase 1 — the Signal Inbox).
//
// ── One surface, two independent feeds ───────────────────────────────────────
//   'saved_search' — projected from discovered_leads. Needs ONLY the Lead Generator.
//   'social'       — read from the `signals` table. Needs the Social Media Assistant too (Phase 1b).
//
// A user with only a Lead Generator must get a fully populated inbox; the social feed is additive.
// That is the governing rule from plan §1.6 — no feature may require two assistants to be useful.
//
// ⚠️ Saved-search signals are PROJECTED, never stored as rows. discovered_leads stays their single
// source of truth. Do not "optimise" this into a real table without reading §4.2a first — the
// dual-write it implies is the exact failure shape that has bitten this codebase twice.

/** Which feed a signal came from. */
export const SOURCE_KINDS = ['saved_search', 'social'] as const;
export type SourceKind = typeof SOURCE_KINDS[number];

/**
 * Where a signal sits relative to becoming a lead.
 *   'auto_promoted' — cleared the confidence threshold, already a lead (no human touch)
 *   'ready'         — awaiting the batch approve (class A gate)
 *   'needs_review'  — an ANOMALY, deliberately excluded from batch approve (class B carve-out)
 *   'promoted'      — approved and mirrored into the Review Queue
 *   'filtered'      — dropped pre-scoring or scored cold; hidden unless "Show filtered" is on
 *   'ignored'       — social noise
 */
export const HANDOFF_STATES = [
    'auto_promoted', 'ready', 'needs_review', 'promoted', 'filtered', 'ignored',
] as const;
export type HandoffState = typeof HANDOFF_STATES[number];

/** States a signal must be in to be swept into a bulk approve. Anything else needs a human. */
const BATCHABLE: ReadonlySet<string> = new Set(['ready']);

/**
 * True when a signal may be included in a batch approve.
 *
 * `needs_review` is excluded ON PURPOSE and this is the load-bearing part of the whole gate design:
 * an anomaly (per §4.3a, a scraped address belonging to a named individual) must never be swept
 * into a bulk action. If a future caller "helpfully" widens this, the personal-inbox protection
 * that lead-generation.ts enforces server-side becomes reachable by a single click on 47 leads.
 */
export function isBatchable(state: unknown): boolean {
    return typeof state === 'string' && BATCHABLE.has(state);
}

/** The normalised shape both feeds are projected into. */
export interface Signal {
    /** Feed-prefixed: 'search:1188' | 'social:412'. NEVER a bare int — the two id spaces collide. */
    id: string;
    sourceKind: SourceKind;
    /** Display category: '<Assistant name> Search' | 'Instagram · DM'. Resolved at READ time. */
    sourceLabel: string;
    /** discovery_campaigns.id — drives the per-search sub-filter. Saved-search signals only. */
    savedSearchId?: number | null;
    /** The saved search's display name, already falling back to a truncated idea. */
    savedSearchName?: string | null;
    title: string;
    excerpt: string;
    /** Social feed only — intent classification. */
    intent?: string | null;
    /** Saved-search feed only — ICP score band. */
    rating?: string | null;
    confidence: number | null;
    handoffStatus: HandoffState;
    /**
     * Where this company stands AS A LEAD — read straight off assistant_records.approval_status.
     *
     * ⚠️ Deliberately NOT derived from `handoffStatus`, which answers a different question ("may
     * this be swept into a batch approve"). The two disagree on a real case: a cold-scored lead is
     * `filtered` for batch purposes but is sitting in the Leads tab awaiting approval like any
     * other, because every scored company is mirrored into assistant_records the moment it is
     * found (process-discovery-jobs.ts promoteOne). Labelling that row "Filtered" told users a
     * lead they own had been discarded.
     */
    leadState?: 'approved' | 'awaiting' | 'rejected' | null;
    /** Why it was filtered, when handoffStatus is 'filtered'. */
    filterReason?: string | null;
    /** Populated once the signal has become an assistant_records row. */
    assistantRecordId?: number | null;
    /** Set when the signal needs individual review; explains why to the user. */
    reviewReason?: string | null;
    occurredAt: string;
}

/**
 * The saved-search category label. Resolved from the assistant's CURRENT name on every read —
 * never stored.
 *
 * Storing "Nadia Search" means renaming the assistant leaves every historical signal labelled with
 * the old name. This codebase already has that trap documented for role label vs instance name;
 * the fix there was the same — resolve at read time via coalesce(master_assistants.name, jobRole).
 */
export function resolveSourceLabel(assistantName: string | null | undefined): string {
    const name = (assistantName ?? '').trim();
    return name ? `${name} Search` : 'Saved search';
}

/**
 * Display name for a saved search: its `name` if set, else a truncated `idea`.
 * Campaigns created before db/signal-inbox-1a.sql have no name, and that is permanent for them —
 * the fallback is the normal path, not an error path.
 */
export function savedSearchLabel(name: string | null | undefined, idea: string | null | undefined, max = 42): string {
    const n = (name ?? '').trim();
    if (n) return n;
    const i = (idea ?? '').trim();
    if (!i) return 'Untitled search';
    return i.length <= max ? i : `${i.slice(0, max - 1).trimEnd()}…`;
}

// ── Cursor ───────────────────────────────────────────────────────────────────
// The inbox pages across a UNION of two feeds, so an OFFSET is wrong: rows arriving in one feed
// shift the other feed's window and the user sees duplicates or gaps. Page on the sort key itself.

export interface InboxCursor {
    /** ISO timestamp of the last row on the previous page. */
    occurredAt: string;
    /** Tie-break within the same timestamp. Feed-prefixed id, so it is globally unique. */
    id: string;
}

/** Encode a cursor for the wire. Opaque to the client by design — the shape may change. */
export function encodeCursor(c: InboxCursor): string {
    return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

/** Decode a client-supplied cursor. Returns null on anything malformed — never throws. */
export function decodeCursor(raw: unknown): InboxCursor | null {
    if (typeof raw !== 'string' || !raw) return null;
    try {
        const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<InboxCursor>;
        if (typeof parsed?.occurredAt !== 'string' || typeof parsed?.id !== 'string') return null;
        if (Number.isNaN(Date.parse(parsed.occurredAt))) return null;
        return { occurredAt: parsed.occurredAt, id: parsed.id };
    } catch {
        return null;
    }
}

/** Newest first, id descending as the tie-break. Must match the SQL ORDER BY exactly. */
export function compareSignals(a: Signal, b: Signal): number {
    if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Default page size. Small enough that a batch approve stays a considered action, not a reflex. */
export const INBOX_PAGE_SIZE = 25;

/**
 * Auto-promote threshold. A saved-search signal scoring at or above this skips the batch entirely.
 *
 * ⚠️ DEFAULT IS null — auto-promotion is OFF until a user opts in. Shipping it on would silently
 * bulk-promote the existing backlog on deploy (135 leads sit unreviewed on staging today), which is
 * precisely the kind of unrequested irreversible action a gate exists to prevent. 75 is the
 * suggested value when they do turn it on, not an active default.
 */
export const AUTO_PROMOTE_THRESHOLD_DEFAULT: number | null = null;
export const AUTO_PROMOTE_THRESHOLD_SUGGESTED = 75;
