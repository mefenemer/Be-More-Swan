// src/config/lead-activity-events.ts
// How a `revenue_events` row reads on the Lead Generator's Activity tab.
//
// This is the PRESENTATION layer over the ledger vocabulary in src/config/revenue-events.ts —
// pure, no db and no Netlify imports, so the sentences a user actually reads can be unit-tested
// without a database (tests/lead-activity-projection.test.ts). netlify/functions/get-lead-activity.ts
// does the querying and calls describeLeadEvent() per row.
//
// ⚠️ Kept OUT of revenue-events.ts on purpose. That file is the closed vocabulary mirrored by a
// CHECK constraint in db/revenue-events.sql; adding wording to it would mean a copy edit looks
// like a schema change. Adding an event here is safe — the map is deliberately partial.

import { LOSS_REASON_LABELS, OUTCOME_LABELS } from './revenue-events';

export type ActivityStatus = 'success' | 'failed' | 'needs_input' | 'in_progress' | 'info';

type Payload = Record<string, unknown>;

/** The fields of a `revenue_events` row this projection reads. Structural, so a test can pass a literal. */
export interface LeadEventRow {
    eventType: string;
    payload?: unknown;
    outcome?: string | null;
    lossReason?: string | null;
    valueGbp?: string | number | null;
}

export interface ProjectedEvent {
    icon: string;
    status: ActivityStatus;
    description: string;
}

function str(v: unknown): string | null {
    return typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : null;
}
function num(v: unknown): number | null {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
}
/** " for Acme Ltd", or '' — the lead's name is resolved from the record and injected as `_title`. */
function who(p: Payload): string {
    const t = str(p._title);
    return t ? ` for ${t}` : '';
}
function to(p: Payload): string {
    const t = str(p._title);
    return t ? ` to ${t}` : '';
}
function reasonSuffix(p: Payload): string {
    const r = str(p.reason) || str(p.detail);
    return r ? ` — ${r}` : '';
}

/**
 * How each ledger event reads on the feed.
 *
 * ⚠️ `status` is the OPERATIONAL outcome the client pins on, not a judgement of the sales result.
 * A lost deal is 'info', not 'failed': the client groups failed + needs_input into a "Needs
 * attention" block above the history, and a deal the user themselves marked lost is neither
 * broken nor waiting on them. What genuinely belongs up there is delivery failing (a bounce) and
 * a cadence stopping for a reason that is not a reply.
 *
 * Anything absent from this map is skipped rather than rendered as its raw event_type — the
 * vocabulary is closed (src/config/revenue-events.ts) but this file is a presentation layer, and
 * "signal_captured" appearing verbatim in a user-facing feed is worse than it not appearing.
 */
const EVENT_META: Record<string, { icon: string; status: ActivityStatus; label: (p: Payload) => string }> = {
    lead_discovered: { icon: 'users', status: 'info', label: (p) => `Found a new lead${who(p)}.` },
    lead_enriched: { icon: 'link', status: 'success', label: (p) => `Found contact details for${who(p) || ' a lead'}.` },
    lead_scored: {
        icon: 'sparkles', status: 'info',
        label: (p) => {
            const rating = str(p.rating);
            const score = num(p.score);
            const detail = [rating, score !== null ? `${score}/100` : null].filter(Boolean).join(', ');
            return `Scored${who(p) || ' a lead'}${detail ? ` — ${detail}` : ''}.`;
        },
    },
    lead_approved: { icon: 'check', status: 'success', label: (p) => `You approved${who(p) || ' a lead'} — outreach released.` },
    lead_rejected: { icon: 'x', status: 'info', label: (p) => `You rejected${who(p) || ' a lead'}.` },
    do_not_contact_overridden: {
        // Amber on purpose. Someone deliberately sent past a compliance gate; that is the one
        // routine event on this feed a person should be asked to look at twice.
        icon: 'shield', status: 'needs_input',
        label: (p) => `Do-not-contact was overridden for${who(p) || ' a lead'}${reasonSuffix(p)}.`,
    },
    outreach_sent: {
        icon: 'rocket', status: 'success',
        label: (p) => {
            const step = num(p.sequenceStep);
            return step && step > 0
                ? `Sent follow-up #${step}${to(p)}.`
                : `Sent the opening email${to(p)}.`;
        },
    },
    outreach_bounced: { icon: 'alert', status: 'failed', label: (p) => `The email${to(p)} bounced.` },
    reply_received: { icon: 'edit', status: 'needs_input', label: (p) => `A prospect replied${who(p)}.` },
    reply_classified: {
        icon: 'sparkles', status: 'info',
        label: (p) => {
            const c = str(p.classification);
            return `Read a reply${who(p)}${c ? ` — ${c.replace(/_/g, ' ')}` : ''}.`;
        },
    },
    // "You replied", not "sent an email" — this row exists to be distinguishable from the
    // assistant's own sends sitting either side of it in the same feed.
    manual_reply_sent: { icon: 'edit', status: 'success', label: (p) => `You replied${to(p)}.` },
    opt_out_received: { icon: 'shield', status: 'info', label: (p) => `A prospect asked not to be contacted${who(p)} — added to your suppression list.` },
    sequence_enrolled: { icon: 'calendar', status: 'info', label: (p) => `Started the follow-up sequence${who(p)}.` },
    sequence_halted: {
        // Split by reason. A cadence that stopped because they REPLIED is the system working, and
        // pinning that into "Needs attention" would put the best outcome in the alarm box.
        icon: 'clock',
        status: 'info',
        label: (p) => {
            const r = str(p.haltReason);
            return `Follow-ups stopped${who(p)}${r ? ` — ${r.replace(/_/g, ' ')}` : ''}.`;
        },
    },
    sequence_completed: { icon: 'check-circle', status: 'info', label: (p) => `Finished the follow-up sequence${who(p)}.` },
    objection_raised: { icon: 'alert', status: 'needs_input', label: (p) => `An objection came back${who(p)}${reasonSuffix(p)}.` },
    objection_handled: { icon: 'check', status: 'success', label: (p) => `Answered an objection${who(p)}.` },
    meeting_booked: { icon: 'calendar', status: 'success', label: (p) => `A meeting was booked${who(p)}.` },
    // ⚠️ Icons are keys into the client's own map (assistants.js iconSvg/iconBg). A key it does
    // not know falls back to the grey cog, so only names from that map may appear here.
    quote_sent: { icon: 'edit', status: 'success', label: (p) => `Sent a quote${who(p)}.` },
    negotiation_opened: { icon: 'edit', status: 'info', label: (p) => `Negotiation opened${who(p)}.` },
    negotiation_conceded: { icon: 'edit', status: 'info', label: (p) => `Conceded a point in negotiation${who(p)}.` },
    payment_link_sent: { icon: 'link', status: 'success', label: (p) => `Sent a payment link${who(p)}.` },
    signal_captured: { icon: 'lightbulb', status: 'info', label: (p) => `Picked up a buying signal${who(p)}.` },
};

/**
 * The three terminal events, which carry their meaning in COLUMNS rather than the payload —
 * `outcome`, `loss_reason` and `value_gbp` are non-NULL on exactly these — so they read from the
 * row itself and not from EVENT_META.
 */
const TERMINAL_META: Record<string, { icon: string; status: ActivityStatus }> = {
    // 'info', not 'failed' — see the EVENT_META note. A lost deal is a recorded outcome, not a
    // malfunction, and must not surface in the client's "Needs attention" block.
    deal_won: { icon: 'check-circle', status: 'success' },
    deal_lost: { icon: 'x', status: 'info' },
    deal_disqualified: { icon: 'x', status: 'info' },
};

function terminalLabel(
    eventType: string,
    outcome: string | null,
    lossReason: string | null,
    valueGbp: string | null,
    p: Payload,
): string {
    const subject = who(p) || ' a lead';
    if (eventType === 'deal_won') {
        const v = valueGbp !== null ? Number(valueGbp) : null;
        const money = v !== null && Number.isFinite(v) && v > 0
            ? ` — £${v.toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
            : '';
        return `Deal won${subject}${money}.`;
    }
    const label = outcome && OUTCOME_LABELS[outcome as keyof typeof OUTCOME_LABELS]
        ? OUTCOME_LABELS[outcome as keyof typeof OUTCOME_LABELS]
        : eventType === 'deal_lost' ? 'Lost' : 'Disqualified';
    const why = lossReason && LOSS_REASON_LABELS[lossReason as keyof typeof LOSS_REASON_LABELS]
        ? ` — ${LOSS_REASON_LABELS[lossReason as keyof typeof LOSS_REASON_LABELS]}`
        : '';
    return `Marked ${label.toLowerCase()}${subject}${why}.`;
}

/**
 * One ledger row → one feed item, or null when the event has no user-facing wording.
 *
 * `title` is the lead's name resolved from assistant_records by the caller; null when the lead has
 * since been deleted, which every label falls back through rather than printing an empty subject.
 */
export function describeLeadEvent(e: LeadEventRow, title: string | null): ProjectedEvent | null {
    const raw = e.payload;
    const p: Payload = {
        ...(raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Payload) : {}),
        _title: title,
    };

    const terminal = TERMINAL_META[e.eventType];
    if (terminal) {
        return {
            icon: terminal.icon,
            status: terminal.status,
            description: terminalLabel(
                e.eventType,
                e.outcome ?? null,
                e.lossReason ?? null,
                e.valueGbp != null ? String(e.valueGbp) : null,
                p,
            ),
        };
    }

    const meta = EVENT_META[e.eventType];
    if (!meta) return null;
    return { icon: meta.icon, status: meta.status, description: meta.label(p) };
}
