// src/utils/lead-launch-watch.ts
// Buying triggers Phase 4 (docs/buying-triggers-plan.md §5): "launched a website" for Watch list companies
// that have no website we know of. Once a month per company, one crt.sh search (the public Certificate
// Transparency log) for a domain that is exactly the company's name (src/lib/triggers/site-watch.ts
// firstCertForName). A first certificate issued AFTER we started watching = news, worded "may be theirs".
//
// Which companies: Watch list rows (lead_watch, any kind) whose lead has no website on record and is not on
// the website watch (lead_site_watch), and companies added by hand (we never know their site).
//
// crt.sh is free and asks for fair use: one company at a time, a 2-second gap, at most CRT_MAX_PER_RUN a run,
// and a failure waits a day. Needs db/z-site-markers.sql (lead_watch.crtsh_checked_at); until then it skips.

import { sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { firstCertForName, launchSignal, nameSlug, type CrtEntry } from '../lib/triggers/site-watch';
import { hasColumn, recordSignal, type WatchRow } from './lead-watch';
import { safeFetchText } from './safe-fetch';

type Db = ReturnType<typeof getDb>;

export const CRT_RECHECK_DAYS = 30;
export const CRT_MAX_PER_RUN = 60;
const CRT_GAP_MS = 2000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface LaunchCheckResult { setUp: boolean; checked: number; launches: number; errors: number }

async function searchCrt(slug: string): Promise<CrtEntry[] | null> {
    try {
        const { body } = await safeFetchText(`https://crt.sh/?q=${encodeURIComponent(`${slug}.%`)}&output=json&exclude=expired`, { timeoutMs: 20_000, maxBytes: 4 * 1024 * 1024 });
        const j = JSON.parse(body || '[]');
        return Array.isArray(j) ? j as CrtEntry[] : null;
    } catch {
        return null;
    }
}

export async function checkLaunches(db: Db, opts: { deadline: number }): Promise<LaunchCheckResult> {
    const out: LaunchCheckResult = { setUp: true, checked: 0, launches: 0, errors: 0 };
    if (!(await hasColumn(db, 'lead_watch', 'crtsh_checked_at'))) return { ...out, setUp: false };
    // The website watch's table may not be applied yet; without it, only discovered_leads says who has a site.
    const [{ site }] = await db.execute(sql`SELECT to_regclass('lead_site_watch') IS NOT NULL AS site`) as Array<{ site: boolean }>;
    const rows = await db.execute(sql`
        SELECT w.id, w.organisation_id, w.ai_assistant_id, w.assistant_record_id, w.company_name, w.ch_number,
               w.ch_last_filing_id, w.ch_status, w.checks_done, w.created_at::date::text AS watched_since
          FROM lead_watch w
         WHERE w.paused_reason IS NULL
           AND w.company_name IS NOT NULL
           AND (w.crtsh_checked_at IS NULL OR w.crtsh_checked_at < now() - make_interval(days => ${CRT_RECHECK_DAYS}))
           AND NOT EXISTS (SELECT 1 FROM discovered_leads d WHERE d.assistant_record_id = w.assistant_record_id AND d.domain IS NOT NULL)
           ${site ? sql`AND NOT EXISTS (SELECT 1 FROM lead_site_watch s WHERE s.assistant_record_id = w.assistant_record_id)` : sql``}
         ORDER BY w.crtsh_checked_at NULLS FIRST, w.id
         LIMIT ${CRT_MAX_PER_RUN}`) as unknown as Array<WatchRow & { watched_since: string }>;
    for (const row of rows) {
        if (Date.now() >= opts.deadline) break;
        const slug = nameSlug(row.company_name);
        if (!slug) {
            await db.execute(sql`UPDATE lead_watch SET crtsh_checked_at = now() WHERE id = ${row.id}`);
            continue;
        }
        const entries = await searchCrt(slug);
        await sleep(CRT_GAP_MS);
        if (!entries) {
            out.errors++;
            await db.execute(sql`UPDATE lead_watch SET crtsh_checked_at = now() - make_interval(days => ${CRT_RECHECK_DAYS - 1}) WHERE id = ${row.id}`);
            continue;
        }
        const found = firstCertForName(entries, slug);
        const sig = launchSignal(found, row.watched_since);
        if (sig && await recordSignal(db, row, sig, 'crtsh')) out.launches++;
        await db.execute(sql`UPDATE lead_watch SET crtsh_checked_at = now(), launch_domain = COALESCE(${found?.domain ?? null}, launch_domain) WHERE id = ${row.id}`);
        out.checked++;
    }
    return out;
}
