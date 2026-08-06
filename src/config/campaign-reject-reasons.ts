// src/config/campaign-reject-reasons.ts
// Why a founder rejected a campaign decision — the vocabulary the Review Queue offers.
//
// ── This ships WITH its consumer, or it does not ship ────────────────────────
// Lead rejection shipped as a status flip that recorded nothing and fed nothing, so a user could
// reject twenty leads for the same reason and the next run was built from identical inputs. The
// same button here would be the same bug with a bigger blast radius, because a rejected campaign
// decision is the agent being told its whole plan is wrong.
//
// So: `applyRejectionToConstraints()` below is the consumer, it is called from campaigns.ts on
// every rejection, and its output is read by the proposal prompt via
// `renderCampaignConstraints()`. There is no path where the reason is written and not read.
//
// ⚠️ The vocabulary is CLOSED because `campaign_decisions.reject_reason` is a GROUP BY key —
// "four rejections in a row for the same reason" has to survive as a count, not as prose for a
// model to re-summarise. Adding a value means changing this file, the CHECK in db/campaigns.sql
// and the check() in db/schema.ts together; tests/campaign-reject-reasons.test.ts parses all
// three and fails when they disagree.

export const CAMPAIGN_REJECT_REASONS = [
    'wrong_channel',      // right idea, wrong place to do it
    'too_expensive',      // the work it costs is not worth the expected return
    'bad_timing',         // fine later, not now
    'evidence_unconvincing', // the numbers do not support the conclusion drawn from them
    'off_brand',          // it would say something we would not say
    'doing_it_myself',    // the human is taking this one
    'other',              // escape hatch — deliberately excluded from every aggregate
] as const;

export type CampaignRejectReason = typeof CAMPAIGN_REJECT_REASONS[number];

/**
 * How each reason is offered.
 *
 * Phrased as the founder would say it out loud. They are clicking this immediately after pressing
 * Reject, with the rest of their day waiting — a label they have to decode gets whatever is
 * nearest the cursor, and a mis-clicked reason is worse than none because it teaches the wrong
 * thing confidently.
 */
export const CAMPAIGN_REJECT_REASON_LABELS: Record<CampaignRejectReason, string> = {
    wrong_channel: 'Wrong channel',
    too_expensive: 'Too much work for the return',
    bad_timing: 'Bad timing',
    evidence_unconvincing: 'I disagree with the evidence',
    off_brand: 'Off brand',
    doing_it_myself: 'I’m doing this myself',
    other: 'Something else',
};

/**
 * The shape stored on a campaign and replayed into the next proposal.
 *
 * Counts, not prose. One rejection is noise; four for the same reason is a rule the agent should
 * have learned. Keeping counts rather than a list of notes is also what stops this growing
 * without bound on a long-running campaign.
 */
export interface CampaignConstraints {
    /** reason → how many times this campaign has been rejected for it. */
    rejections: Partial<Record<CampaignRejectReason, number>>;
    /** Free-text notes, newest first, hard-capped. Advisory only — never a GROUP BY key. */
    notes: string[];
}

export const EMPTY_CONSTRAINTS: CampaignConstraints = { rejections: {}, notes: [] };

/** Keep the note list bounded: an unbounded array in a jsonb column is a slow leak into the prompt. */
const MAX_NOTES = 10;

/**
 * Fold one rejection into a campaign's constraint set. Pure — the caller persists the result.
 *
 * `other` is counted like any other reason so the total is honest, but `renderCampaignConstraints`
 * withholds it from the directive: it is a bucket, not a signal, and feeding it to a model invites
 * an invented explanation for a rejection the user declined to explain.
 */
export function applyRejectionToConstraints(
    current: CampaignConstraints | null | undefined,
    reason: CampaignRejectReason,
    note?: string | null,
): CampaignConstraints {
    const base: CampaignConstraints = {
        rejections: { ...(current?.rejections ?? {}) },
        notes: [...(current?.notes ?? [])],
    };
    base.rejections[reason] = (base.rejections[reason] ?? 0) + 1;
    const trimmed = (note ?? '').trim();
    if (trimmed) base.notes = [trimmed.slice(0, 280), ...base.notes].slice(0, MAX_NOTES);
    return base;
}

/**
 * How many repeats before a reason becomes a stated rule rather than a data point.
 *
 * Two, not one. A single rejection can be about the specific proposal; two for the same reason is
 * about the approach. Set higher and the loop is too slow to feel like learning; set to one and
 * one bad click permanently narrows the agent.
 */
export const CONSTRAINT_THRESHOLD = 2;

/**
 * Render a campaign's accumulated rejections as instructions for the next proposal.
 *
 * Returns '' when nothing has hit the threshold — an empty section is worse than no section,
 * because a header with nothing under it reads as "constraints exist but are unknown".
 *
 * THIS is what makes the Reject button real. If you are changing the reject flow, change this in
 * the same commit or take the button away.
 */
export function renderCampaignConstraints(c: CampaignConstraints | null | undefined): string {
    if (!c?.rejections) return '';
    const lines: string[] = [];
    for (const [reason, count] of Object.entries(c.rejections)) {
        if (reason === 'other') continue;               // a bucket, not a signal
        if ((count ?? 0) < CONSTRAINT_THRESHOLD) continue;
        const rule = CONSTRAINT_RULES[reason as CampaignRejectReason];
        if (rule) lines.push(`- ${rule} (rejected ${count}× for this reason)`);
    }
    if (!lines.length) return '';
    return [
        'The person you work for has already turned down proposals on this campaign. Do not propose the same thing again:',
        ...lines,
    ].join('\n');
}

/**
 * The instruction each repeated reason becomes.
 *
 * Written as a constraint on the NEXT proposal, not as a description of the past — a model reading
 * "the user dislikes LinkedIn" will helpfully mention LinkedIn; one reading "do not propose
 * LinkedIn" will not. `other` and `doing_it_myself` have no rule on purpose: the first says
 * nothing, and the second is about who does the work, not about what the work should be.
 */
const CONSTRAINT_RULES: Partial<Record<CampaignRejectReason, string>> = {
    wrong_channel: 'Do not propose the same channel mix again — change which assistants you use, not just the wording.',
    too_expensive: 'Propose smaller pieces of work. Fewer items, or cheaper ones, for the same objective.',
    bad_timing: 'Do not re-propose work that has to start immediately; offer something that can begin later in the campaign.',
    evidence_unconvincing: 'Only propose changes backed by a number this campaign has actually produced. Do not argue from general marketing principle.',
    off_brand: 'Stay strictly inside the existing brand voice and content rules. Do not propose a new angle, tone or claim.',
};

const REASON_SET: ReadonlySet<string> = new Set(CAMPAIGN_REJECT_REASONS);

/** Narrow an untyped value (a JSON body, a DB row) to the union. */
export function isCampaignRejectReason(v: unknown): v is CampaignRejectReason {
    return typeof v === 'string' && REASON_SET.has(v);
}
