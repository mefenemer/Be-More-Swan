// src/utils/lead-effort.ts
//
// "Effort Saved" / "Money Saved" for the Lead Generation Assistant — the arithmetic only, so it is
// unit-testable without a database. The query lives in netlify/functions/get-lead-roi.ts.
//
// ── Why this exists at all ───────────────────────────────────────────────────
// The hero's Time/Money strip is fed by get-assistant-metrics.ts, whose formula is
// posts × content_drafted + completed task runs × tasks_completed + leads × leads_generated. For a
// Lead Generator the first term is structurally zero (it publishes nothing) and the third reads the
// `leads` table — which is Be More Swan's OWN trial pipeline, not the tenant's leads, and is only
// folded in when the assistant is the org's only one. So the strip could only ever have reported
// the task-run term, and the registry hid it outright (hasImpactRoi:false). The result was that the
// one role whose whole pitch is "this is cheaper than a person" was the one role that never said so.
//
// ── The model, and its honesty constraints ───────────────────────────────────
// Every figure is counted from `revenue_events` — the append-only ledger every lead lifecycle
// transition already writes (src/utils/revenue-ledger.ts is its only writer). Nothing is derived
// from the current shape of assistant_records: a lead worked in March and deleted in June still did
// that work in March.
//
// The minutes-per-item come from the SAME platform config the dashboard hero uses
// (GAMIFICATION_TIME_MULTIPLIERS → getTimeMultipliers). No new constants are invented here, and an
// operator retuning the multipliers retunes this strip with everything else. What this file adds is
// only the MAPPING from a lead event to which of those three multipliers describes it.
//
// ⚠️ The figure is an ESTIMATE and every surface that prints it has to say so. Nothing in the
// platform times a human doing this work by hand — the same objection that got "Hours Reclaimed"
// struck off the Lead Generator's KPI cards. The difference here is that the strip is explicitly
// labelled as a rate-card estimate and shows its own workings (see `breakdown`), rather than
// presenting an estimate in the position where the other three cards print measurements.

import type { TimeMultipliers } from './platform-config';

/**
 * One kind of work the assistant did, and which multiplier describes it.
 *
 * `distinct` says whether repeat events on the SAME lead are repeat work:
 *   • discovery and enrichment are per-lead — finding the same company twice is not two researches.
 *   • outreach and replies are per-message — every chaser is another email a human would have had
 *     to write, and that is precisely the work this assistant takes on after the first send.
 */
export interface EffortItem {
    /** revenue_events.event_type this row counts. */
    eventType: string;
    /** Which of the three platform multipliers gives its minutes. */
    multiplier: keyof TimeMultipliers;
    /** Count distinct leads (true) or rows (false). */
    distinct: boolean;
    /** How it reads on screen, singular / plural. */
    unit: [one: string, many: string];
}

/**
 * The four things a Lead Generator does that a person would otherwise have done by hand.
 *
 * Deliberately short. Every entry has to survive the question "would a human genuinely have spent
 * minutes on this?", which is why `lead_scored` is absent (the scoring is the assistant's own
 * apparatus, not a task it lifted off anyone) and why the sequence lifecycle events
 * (sequence_enrolled / halted / completed) are absent too — they are bookkeeping about sends that
 * `outreach_sent` has already counted.
 */
export const EFFORT_ITEMS: readonly EffortItem[] = [
    { eventType: 'lead_discovered', multiplier: 'leads_generated', distinct: true, unit: ['company researched', 'companies researched'] },
    { eventType: 'lead_enriched', multiplier: 'leads_generated', distinct: true, unit: ['contact tracked down', 'contacts tracked down'] },
    { eventType: 'outreach_sent', multiplier: 'content_drafted', distinct: false, unit: ['email written and sent', 'emails written and sent'] },
    { eventType: 'reply_received', multiplier: 'tasks_completed', distinct: false, unit: ['reply read and triaged', 'replies read and triaged'] },
] as const;

export interface EffortLine {
    eventType: string;
    count: number;
    minutesEach: number;
    minutes: number;
    label: string;
}

export interface LeadEffort {
    /** True when anything at all was counted — the strip stays hidden otherwise. */
    hasData: boolean;
    hoursSaved: number;
    /** null when the user has not set an hourly rate; the card then links them to Settings. */
    gbpSaved: number | null;
    hourlyRateSet: boolean;
    /** Per-kind workings, biggest first, so the headline can be checked rather than trusted. */
    breakdown: EffortLine[];
    /** Total work items behind the headline — the one-line summary under "Effort Saved". */
    items: number;
}

/**
 * Fold the per-event counts into hours and pounds.
 *
 * `counts` is keyed by event_type; a missing key is zero. Rounding matches get-assistant-metrics so
 * the two strips can be read side by side without one of them looking more precise than it is.
 */
export function buildLeadEffort(
    counts: Record<string, number>,
    mult: TimeMultipliers,
    hourlyRateGbp: number | null,
): LeadEffort {
    const breakdown: EffortLine[] = [];
    let totalMinutes = 0;
    let items = 0;

    for (const item of EFFORT_ITEMS) {
        const count = Number(counts[item.eventType]) || 0;
        if (count <= 0) continue;
        const minutesEach = Number(mult[item.multiplier]) || 0;
        const minutes = count * minutesEach;
        totalMinutes += minutes;
        items += count;
        breakdown.push({
            eventType: item.eventType,
            count,
            minutesEach,
            minutes,
            label: count === 1 ? item.unit[0] : item.unit[1],
        });
    }

    breakdown.sort((a, b) => b.minutes - a.minutes);

    const hoursSaved = parseFloat((totalMinutes / 60).toFixed(1));
    return {
        hasData: items > 0,
        hoursSaved,
        // ⚠️ Guarded on a POSITIVE rate, not merely a non-null one. A profile carrying "0" would
        // otherwise print "£0 saved" beside forty hours of work — a confident claim that the
        // assistant is worthless, produced entirely by a blank settings field.
        gbpSaved: hourlyRateGbp && hourlyRateGbp > 0
            ? parseFloat((hoursSaved * hourlyRateGbp).toFixed(2))
            : null,
        hourlyRateSet: !!(hourlyRateGbp && hourlyRateGbp > 0),
        breakdown,
        items,
    };
}

/** The shape returned when there is nothing to measure — same keys, so no caller special-cases it. */
export function emptyLeadEffort(): LeadEffort {
    return { hasData: false, hoursSaved: 0, gbpSaved: null, hourlyRateSet: false, breakdown: [], items: 0 };
}
