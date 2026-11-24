// src/utils/partner-start.ts
// A partnership STARTS when the partner accepts the Partner Terms after an admin has approved them (owner, 2026-11-24).
//   • partners.partner_since = that moment ("Partner since" on the Partner page, notice length in Terms 7.5(d), and
//     §7.5(i): only customers who first pay from then on earn).
//   • The 6-month activity clock (partner-activity.ts) starts then.
//   • Any pending special rate (partner_pending_rates, agreed with no dates) becomes a dated rate period: it starts that
//     moment and ends window_months later.
// Called after an approval (if the current terms were already accepted) and after an acceptance (if already approved).
// Idempotent: a partnership that has started is never re-started (partner_since stays put).

import { sql } from 'drizzle-orm';
import { PARTNER_TERMS_VERSION } from '../config/partner-terms';
import { addMonthsUtc } from './partner-rate-periods';

type Db = any;
type Row = Record<string, any>;

/** The special rate's window once the partnership starts: [start, start + windowMonths). */
export function pendingWindow(start: Date, windowMonths: number): { startsAt: Date; endsAt: Date } {
    return { startsAt: start, endsAt: addMonthsUtc(start, windowMonths) };
}

/** Has this partner's current partnership started? (Approved, current terms accepted, partner_since set.) */
export function canStart(p: { status: string; terms_version: string | null; partner_since: unknown }): boolean {
    return p.status === 'approved' && p.terms_version === PARTNER_TERMS_VERSION && !p.partner_since;
}

export async function startPartnershipIfReady(db: Db, partnerId: number, now: Date = new Date()): Promise<{ started: boolean; specialRate: { startsAt: Date; endsAt: Date } | null }> {
    const nowIso = now.toISOString();
    // Conditional on the state that makes it ready, so a double call (approve + accept at once) starts it once.
    const started = (await db.execute(sql`
        UPDATE partners SET partner_since = ${nowIso}::timestamp, activity_pause_days = 0, activity_pause_anchor = ${nowIso}::timestamp, updated_at = now()
         WHERE id = ${partnerId} AND status = 'approved' AND partner_since IS NULL AND terms_version = ${PARTNER_TERMS_VERSION}
         RETURNING id`)) as Row[];
    if (!started.length) return { started: false, specialRate: null };

    const [pending] = (await db.execute(sql`SELECT * FROM partner_pending_rates WHERE partner_id = ${partnerId}`)) as Row[];
    if (!pending) return { started: true, specialRate: null };
    const w = pendingWindow(now, Number(pending.window_months) || 12);
    await db.execute(sql`
        INSERT INTO partner_rate_periods (partner_id, rate_bps, cost_deduction_bps, duration_months, starts_at, ends_at, label, created_by)
        VALUES (${partnerId}, ${pending.rate_bps}, ${pending.cost_deduction_bps}, ${pending.duration_months},
                ${w.startsAt.toISOString()}::timestamp, ${w.endsAt.toISOString()}::timestamp,
                ${pending.label ?? 'Special rate — started when the partner accepted the Partner Terms'}, ${pending.created_by})`);
    await db.execute(sql`DELETE FROM partner_pending_rates WHERE partner_id = ${partnerId}`);
    return { started: true, specialRate: w };
}
