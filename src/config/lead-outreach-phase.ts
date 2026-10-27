// src/config/lead-outreach-phase.ts
// Which step of the outreach journey a lead is at — To approve → Following up → Replied → Finished,
// or Archived — decided in ONE place. docs/lead-outreach-restructure-plan.md, Phase 1.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// Before it, a sent lead was described by three surfaces that each asked a different table:
// Outreach ▸ Approved (approval_status IN approved,scheduled), Outreach ▸ Awaiting reply
// (approval_status = scheduled — the chase reminder) and Conversations (lead_threads). One lead,
// three places, and no function anywhere that said which ONE it belonged in. The staged Outreach
// tab, its counts and the chat's description of the pipeline must all give the same answer, so the
// answer is this function and nothing else.
//
// ⚠️ "Phase", never "stage". `data.outreachStage` already exists and means something else entirely:
// the human Triage ↔ Review override (src/config/lead-recipient.ts leadOutreachStage). Two fields
// called "stage" on one lead would be read as one.
//
// ── The precedence, in order ─────────────────────────────────────────────────
//   1. rejected                                   → archived
//   2. a deal outcome is recorded                 → finished (won / lost / disqualified)
//      Covers a deal won on the phone while chasers were still running; set_outcome already halts
//      the cadence (lead-generation.ts → haltEnrolmentsForRecord), so the two agree.
//   3. they opted out in a reply (thread closed)  → finished (opted out)
//   4. they replied, or signed up through the offer link → replied — a human has to look
//   5. sent, and the follow-ups are not over      → following up
//   6. sent, follow-ups over with no reply        → finished (no reply / opted out)
//   7. not sent                                   → to approve
//
// `needsAttention` is a FLAG, not a phase: a mailbox that disconnected mid-cadence is still a lead
// being followed up, and the fix (reconnect) happens on its row. A column of its own would be one
// more place for the same lead to be.
//
// ── Why a config module and not a util ───────────────────────────────────────
// The browser cannot import from src/, so this is stringified into src/generated/platform-constants.js
// as `window.LeadOutreachPhase` by scripts/gen-client-constants.ts — same mechanism as
// lead-outreach-state.ts. ⚠️ `leadOutreachPhase` is emitted via `.toString()`, so it must stay
// self-contained: no imports, no closures over anything outside its own body, and no TypeScript-only
// syntax that survives compilation (tsx strips the types; the body must be plain JS underneath).

/** The phases, in the order they are shown left to right. */
export const LEAD_OUTREACH_PHASES = ['to_approve', 'following_up', 'replied', 'finished', 'archived'] as const;
export type LeadOutreachPhase = typeof LEAD_OUTREACH_PHASES[number];

/** How each phase is named on screen. */
export const LEAD_OUTREACH_PHASE_LABELS: Record<LeadOutreachPhase, string> = {
    to_approve: 'To approve',
    following_up: 'Following up',
    replied: 'Replied',
    finished: 'Finished',
    archived: 'Archived',
};

/**
 * The group a lead sits in WITHIN its phase. Phases are the left-to-right steps; groups answer the
 * next question on each one ("is this mine to send, or is the app chasing it?").
 */
export const LEAD_OUTREACH_GROUPS = [
    // to_approve
    'review',          // a drafted first email waiting for sign-off
    'send_yourself',   // approved, but not sent: no inbox connected, or one-email-only mode
    // following_up
    'chasing',         // the follow-up plan is running
    'no_follow_ups',   // sent from the app, no follow-ups (switched off, or the plan never started)
    'outside_app',     // the user marked it sent by hand — no thread, so nothing can chase it
    // replied
    'replied',
    // finished
    'won', 'lost', 'disqualified',
    'no_reply',        // the whole plan ran, or was stopped, with no reply
    'opted_out',       // they asked not to be contacted (reply opt-out, suppression, do-not-contact)
    // archived
    'archived',
] as const;
export type LeadOutreachGroup = typeof LEAD_OUTREACH_GROUPS[number];

export const LEAD_OUTREACH_GROUP_LABELS: Record<LeadOutreachGroup, string> = {
    review: 'Waiting for your approval',
    send_yourself: 'Approved — send it yourself',
    chasing: 'Follow-ups running',
    no_follow_ups: 'No follow-ups',
    outside_app: 'Contacted outside the app',
    replied: 'Replied',
    won: 'Won',
    lost: 'Lost',
    disqualified: 'Disqualified',
    no_reply: 'No reply',
    opted_out: 'Opted out',
    archived: 'Archived',
};

/** The follow-up enrolment as the phase needs it. Mirrors sequence_enrolments. */
export interface LeadOutreachEnrolment {
    state: string;                 // active | completed | halted | cancelled
    haltReason?: string | null;
    lastError?: string | null;
}

export interface LeadOutreachPhaseInput {
    /** assistant_records.approval_status. */
    approvalStatus?: string | null;
    /** assistant_records.data. */
    data?: unknown;
    /** lead_threads.state, or null when no thread exists (never sent from the app). */
    threadState?: string | null;
    /** The thread's sequence_enrolments row, or null when follow-ups never started. */
    enrolment?: LeadOutreachEnrolment | null;
}

export interface LeadOutreachPhaseResult {
    phase: LeadOutreachPhase;
    group: LeadOutreachGroup;
    /** Something the user has to fix for this lead to keep moving (e.g. reconnect their mailbox). */
    needsAttention: boolean;
}

/**
 * The one answer to "where is this lead in its outreach?".
 *
 * ⚠️ `to_approve` / `review` is returned for EVERY pending_approval lead, including ones with no
 * address or draft. Whether a pending lead is actually shown in Review is a separate, existing rule
 * (window.LeadOutreachStage.isInReview / the server's ?deliverable=1) — callers apply it on top.
 */
export function leadOutreachPhase(input: LeadOutreachPhaseInput): LeadOutreachPhaseResult {
    var i = input || {};
    var d = (i.data && typeof i.data === 'object' && !Array.isArray(i.data)) ? i.data as Record<string, unknown> : {};
    var e = i.enrolment || null;
    var thread = typeof i.threadState === 'string' && i.threadState ? i.threadState : null;
    var halt = e && typeof e.haltReason === 'string' ? e.haltReason : null;

    // A mailbox or send problem the user can fix. Halted on one of these, the cadence will not
    // resume by itself; still active with an error, it is retrying and failing.
    var attention = !!e && (
        (e.state === 'halted' && (halt === 'not_connected' || halt === 'send_failed'))
        || (e.state === 'active' && typeof e.lastError === 'string' && e.lastError.trim() !== '')
    );
    // ⚠️ No inner helper function for building the result. tsx compiles with keepNames, which wraps
    // every nested function in `__name(...)` — a helper that exists in Node and NOT in the browser,
    // so the stringified copy in platform-constants.js would throw on its first call.

    // 1. Turned down.
    if (i.approvalStatus === 'rejected') return { phase: 'archived', group: 'archived', needsAttention: false };

    // 2. A human recorded how it ended. Unknown outcome values fall to the most neutral bucket rather
    //    than vanishing — they are still decided.
    var outcome = d.dealOutcome && typeof d.dealOutcome === 'object' && !Array.isArray(d.dealOutcome)
        ? (d.dealOutcome as Record<string, unknown>).outcome : null;
    if (typeof outcome === 'string' && outcome) {
        if (outcome === 'won' || outcome === 'lost') return { phase: 'finished', group: outcome, needsAttention: false };
        return { phase: 'finished', group: 'disqualified', needsAttention: false };
    }

    // 3. They replied asking not to be contacted — inbound-email.ts closes the thread outright.
    if (thread === 'closed') return { phase: 'finished', group: 'opted_out', needsAttention: false };

    // 4. They answered, or said yes through the offer link. Either way a person has to look.
    if (thread === 'replied' || halt === 'replied' || halt === 'signed_up') return { phase: 'replied', group: 'replied', needsAttention: false };

    var sentAt = d.outreachSentAt;
    var sent = !!thread || (typeof sentAt === 'string' && sentAt.trim() !== '');

    if (sent) {
        // Hand-marked "sent" with no thread: the app cannot see replies or chase it.
        if (!thread) return { phase: 'following_up', group: 'outside_app', needsAttention: false };
        // 'stalled' is in the thread vocabulary; it means the conversation went nowhere.
        if (thread === 'stalled') return { phase: 'finished', group: 'no_reply', needsAttention: false };
        if (!e) return { phase: 'following_up', group: 'no_follow_ups', needsAttention: false };
        if (e.state === 'active') return { phase: 'following_up', group: 'chasing', needsAttention: attention };
        // Stopped by a fixable problem: keep it in front of the user, flagged, not filed as over.
        if (attention) return { phase: 'following_up', group: 'chasing', needsAttention: true };
        if (halt === 'suppressed' || halt === 'do_not_contact') return { phase: 'finished', group: 'opted_out', needsAttention: false };
        return { phase: 'finished', group: 'no_reply', needsAttention: false };
    }

    // 7. Not sent. Approved-but-unsent is the user's to send (no inbox, or manual outreach).
    if (i.approvalStatus === 'approved' || i.approvalStatus === 'scheduled') return { phase: 'to_approve', group: 'send_yourself', needsAttention: false };
    return { phase: 'to_approve', group: 'review', needsAttention: false };
}
