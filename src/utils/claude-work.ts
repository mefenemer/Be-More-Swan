// src/utils/claude-work.ts — Claude's drafts in the Inbox and its work on feature requests, as the admin
// portal shows them (owner, 2026-11-13; docs/claude-inbox-and-features.md).
//
// Columns from db/z-claude-drafts-and-features.sql, read raw behind claudeWorkColumnsReady() (not in
// db/schema.ts, so a database without the SQL keeps working and simply shows no drafts or notes).
// Claude writes them from its session with scripts/inbox-drafts.ts and scripts/feature-requests.ts;
// nothing here sends anything to a customer.

import { sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';

type Db = ReturnType<typeof getDb>;

export const CLAUDE_RUNNER_ID = 'Claude (interactive)';

let readyCache: { ready: boolean; at: number } | null = null;
export async function claudeWorkColumnsReady(db: Db): Promise<boolean> {
    if (readyCache && (readyCache.ready || Date.now() - readyCache.at < 5 * 60_000)) return readyCache.ready;
    try {
        const rows = await db.execute(sql`
            SELECT 1 FROM information_schema.columns
             WHERE table_name = 'feature_requests' AND column_name = 'dev_notes' LIMIT 1`) as unknown[];
        readyCache = { ready: rows.length > 0, at: Date.now() };
    } catch {
        readyCache = { ready: false, at: Date.now() };
    }
    return readyCache.ready;
}
export function resetClaudeWorkCache(): void { readyCache = null; }

export interface TicketDraft { reply: string; note: string | null; at: string | null }

/** Claude's draft reply for one support ticket, or null. */
export async function loadTicketDraft(db: Db, ticketId: number): Promise<TicketDraft | null> {
    if (!(await claudeWorkColumnsReady(db))) return null;
    const rows = await db.execute(sql`
        SELECT draft_reply, draft_note, draft_at::text AS draft_at FROM support_tickets
         WHERE id = ${ticketId} AND draft_reply IS NOT NULL`) as Array<{ draft_reply: string; draft_note: string | null; draft_at: string | null }>;
    const r = rows[0];
    return r ? { reply: r.draft_reply, note: r.draft_note, at: r.draft_at } : null;
}

/** Drop the draft (the owner sent a public reply, or discarded it). */
export async function clearTicketDraft(db: Db, ticketId: number): Promise<void> {
    if (!(await claudeWorkColumnsReady(db))) return;
    await db.execute(sql`UPDATE support_tickets SET draft_reply = NULL, draft_note = NULL, draft_at = NULL WHERE id = ${ticketId}`);
}

export interface FeatureDev { claudeWorking: boolean; devPrUrl: string | null; devNotes: string | null }

/** Claude's notes, PR and "working now" flag for feature requests, by id. */
export async function loadFeatureDev(db: Db, ids: number[]): Promise<Map<number, FeatureDev>> {
    const out = new Map<number, FeatureDev>();
    if (!ids.length || !(await claudeWorkColumnsReady(db))) return out;
    const rows = await db.execute(sql`
        SELECT id, dev_pr_url, dev_notes,
               (dev_runner_id = ${CLAUDE_RUNNER_ID} AND dev_runner_heartbeat > now() - interval '30 minutes') AS working
          FROM feature_requests
         WHERE id IN ${sql.raw(`(${ids.map((i) => Number(i)).filter(Number.isFinite).join(',') || 'NULL'})`)}
           AND (dev_pr_url IS NOT NULL OR dev_notes IS NOT NULL OR dev_runner_id IS NOT NULL)`) as Array<{ id: number; dev_pr_url: string | null; dev_notes: string | null; working: boolean | null }>;
    for (const r of rows) out.set(Number(r.id), { claudeWorking: !!r.working, devPrUrl: r.dev_pr_url, devNotes: r.dev_notes });
    return out;
}
