// src/config/campaign-vocab.ts
// The Campaign Assistant's closed vocabularies — campaign status, order actions, order status,
// decision kind and outcome metric — plus the cost model that prices an order in WORK ITEMS.
//
// ⚠️ Every list here is CHECK-constrained in db/campaigns.sql and mirrored in db/schema.ts.
// tests/campaign-vocab.test.ts parses all three and fails if they disagree. Adding a value means
// changing all three in the same commit.
//
// ── Why these are closed ─────────────────────────────────────────────────────
// Same argument as LEAD_REJECT_REASONS and LOSS_REASONS: these values are GROUP BY keys and UI
// switch keys. A free-text status is a status nothing can filter on, and a free-text action is an
// action the executor cannot dispatch. The one place free text belongs is `campaigns.objective`,
// which is the founder's own sentence and is never parsed.

import { BLOG_WRITER_ROLE_KEY, LEAD_GENERATOR_ROLE_KEY, SMM_ROLE_KEY } from '../constants/roles';

// ── Campaign mode ────────────────────────────────────────────────────────────
/**
 * `organic` is the only mode Phase 1 can create.
 *
 * `paid` and `blended` exist so the Phase 3 code has a value to write and so the money columns are
 * not retro-fitted later, but `campaigns.ts` refuses them at the HTTP boundary. They are blocked on
 * Meta business verification, a LinkedIn Advertising product application and a Google Ads developer
 * token — none of which are code (docs/campaign-orchestrator-plan.md §1.1).
 */
export const CAMPAIGN_MODES = ['organic', 'paid', 'blended'] as const;
export type CampaignMode = typeof CAMPAIGN_MODES[number];

/** The modes a tenant may actually create today. Enforced server-side, not just in the UI. */
export const CREATABLE_CAMPAIGN_MODES: readonly CampaignMode[] = ['organic'];

// ── Campaign status ──────────────────────────────────────────────────────────
/**
 * ⚠️ `throttled` and `paused` are deliberately different states, not two words for one thing.
 *
 * `throttled` = the agent reduced this campaign's rate because something is underperforming. The
 * campaign is STILL RUNNING and will recover on its own.
 * `paused`    = it stopped. Nothing further happens until a human or a rule resumes it, and
 * `halt_reason` is NOT NULL by CHECK constraint.
 *
 * Collapsing them into one chip is the connection-status mistake — a shared label hides which of
 * two very different things happened, and the user cannot tell whether to intervene.
 */
export const CAMPAIGN_STATUSES = ['draft', 'active', 'throttled', 'paused', 'finished', 'archived'] as const;
export type CampaignStatus = typeof CAMPAIGN_STATUSES[number];

/** Statuses the dispatcher will act on. Anything else is inert by definition. */
export const LIVE_CAMPAIGN_STATUSES: readonly CampaignStatus[] = ['active', 'throttled'];

export const CAMPAIGN_STATUS_LABELS: Record<CampaignStatus, string> = {
    draft: 'Draft',
    active: 'Running',
    throttled: 'Throttled',
    paused: 'Paused',
    finished: 'Finished',
    archived: 'Archived',
};

// ── Outcome metric: what "done" counts as ────────────────────────────────────
/**
 * Deliberately short. Each value must be something the platform can COUNT from its own tables —
 * an objective measured by a number nobody can produce is a progress bar wired to nothing, which
 * is exactly how SMART Goals shipped decorative.
 */
export const CAMPAIGN_OUTCOME_METRICS = ['leads', 'replies', 'signups', 'published_content'] as const;
export type CampaignOutcomeMetric = typeof CAMPAIGN_OUTCOME_METRICS[number];

export const CAMPAIGN_OUTCOME_LABELS: Record<CampaignOutcomeMetric, string> = {
    leads: 'New leads found',
    replies: 'Replies from prospects',
    signups: 'Signups captured',
    published_content: 'Pieces published',
};

/**
 * Where each outcome is counted from. Named here so a future reader can check the claim rather
 * than trust it, and so no call site invents its own source.
 */
export const CAMPAIGN_OUTCOME_SOURCES: Record<CampaignOutcomeMetric, string> = {
    leads: 'assistant_records (record_type=lead) created while the campaign was live',
    replies: 'lead_threads inbound messages classified as a reply',
    signups: 'revenue_events — NOT counted until the Phase 2 capture page exists',
    published_content: 'scheduled_posts + blog_posts with a published state',
};

/**
 * Outcomes that cannot be counted yet. The UI must not offer these as a target: an objective the
 * platform can never score is worse than no objective, because the campaign will read as failing
 * forever. `signups` needs the Phase 2 BMS-hosted capture page.
 */
export const UNAVAILABLE_OUTCOME_METRICS: readonly CampaignOutcomeMetric[] = ['signups'];

// ── Orders: what the orchestrator can ask a colleague to do ──────────────────
/**
 * An action is admissible only if BOTH halves exist today:
 *   1. a real mechanism that makes it happen (a job row, a campaign row, a directive), and
 *   2. a checkable artefact that comes back, so `campaign_orders.artefact_id` is not aspirational.
 *
 * That test is why there is no `boost_post`, no `create_ad`, and no `build_landing_page` here.
 */
export const CAMPAIGN_ORDER_ACTIONS = [
    'draft_social_posts',
    'draft_blog_pillar',
    'run_lead_search',
    'narrow_targeting',
    'adjust_messaging',
] as const;
export type CampaignOrderAction = typeof CAMPAIGN_ORDER_ACTIONS[number];

export interface OrderActionSpec {
    /** The only role that may receive this order. */
    roleKey: string;
    label: string;
    /** What the user is told will happen. Present tense, no hedging — it either does this or it is not admissible. */
    description: string;
    /**
     * Work items per unit. `draft_social_posts` is priced per post (quantity = post count);
     * the steering-only actions cost 0 because they create no artefact — they change the brief
     * that existing work is generated from.
     */
    workItemsPerUnit: number;
    /** Does `brief.quantity` mean anything for this action? */
    takesQuantity: boolean;
    /** What comes back, matching campaign_orders.artefact_kind. */
    artefactKind: 'scheduled_post' | 'blog_post' | 'discovery_campaign' | null;
}

export const ORDER_ACTION_SPECS: Record<CampaignOrderAction, OrderActionSpec> = {
    draft_social_posts: {
        roleKey: SMM_ROLE_KEY,
        label: 'Draft social posts',
        description: 'Queues extra posts for the Social Media Assistant to draft, on this campaign’s message. They land in its Posts queue for your approval like any other draft.',
        workItemsPerUnit: 1,
        takesQuantity: true,
        artefactKind: 'scheduled_post',
    },
    draft_blog_pillar: {
        roleKey: BLOG_WRITER_ROLE_KEY,
        label: 'Write a pillar article',
        description: 'Briefs the Blog Writing Assistant to write one long-form article for this campaign, carrying its keywords and call to action.',
        // Priced above a post because a pillar is a bigger unit of work, and because the whole
        // point of a shared unit is that the orchestrator can compare unlike things.
        workItemsPerUnit: 6,
        takesQuantity: true,
        artefactKind: 'blog_post',
    },
    run_lead_search: {
        roleKey: LEAD_GENERATOR_ROLE_KEY,
        label: 'Run a lead search',
        description: 'Creates a saved search for the Lead Generation Assistant aimed at this campaign’s audience. Created as a draft — starting it is a separate, human click, because a run costs money and reaches real strangers.',
        workItemsPerUnit: 4,
        takesQuantity: false,
        artefactKind: 'discovery_campaign',
    },
    narrow_targeting: {
        roleKey: LEAD_GENERATOR_ROLE_KEY,
        label: 'Narrow the targeting',
        description: 'Edits an existing saved search — tightens the ideal-customer description and adds negative keywords — so it stops finding the wrong kind of company.',
        workItemsPerUnit: 0,
        takesQuantity: false,
        artefactKind: 'discovery_campaign',
    },
    adjust_messaging: {
        roleKey: SMM_ROLE_KEY,
        label: 'Adjust the messaging',
        description: 'Changes the angle this campaign asks for. Applies to work drafted from now on; it does not rewrite drafts that already exist.',
        workItemsPerUnit: 0,
        takesQuantity: false,
        artefactKind: null,
    },
};

/**
 * Price an order in work items.
 *
 * Pure and total: an unknown action is 0 rather than a throw, because this runs inside the
 * proposal path where a drifting model can emit anything, and a crash there loses the whole turn.
 * The caller validates the action separately — `isOrderAction` is the gate, this is the meter.
 */
export function orderWorkItems(action: string, quantity = 1): number {
    const spec = ORDER_ACTION_SPECS[action as CampaignOrderAction];
    if (!spec) return 0;
    const n = spec.takesQuantity ? Math.max(1, Math.floor(quantity) || 1) : 1;
    return spec.workItemsPerUnit * n;
}

// ── Order status ─────────────────────────────────────────────────────────────
export const CAMPAIGN_ORDER_STATUSES = [
    'queued', 'issued', 'in_review', 'delivered', 'blocked', 'cancelled', 'rejected',
] as const;
export type CampaignOrderStatus = typeof CAMPAIGN_ORDER_STATUSES[number];

/** Statuses where the work is finished, one way or another — no further spend can accrue. */
export const TERMINAL_ORDER_STATUSES: readonly CampaignOrderStatus[] = ['delivered', 'cancelled', 'rejected'];

export const CAMPAIGN_ORDER_STATUS_LABELS: Record<CampaignOrderStatus, string> = {
    queued: 'Queued',
    issued: 'With the assistant',
    in_review: 'In your review',
    delivered: 'Delivered',
    blocked: 'Blocked',
    cancelled: 'Cancelled',
    rejected: 'Rejected',
};

// ── Decisions ────────────────────────────────────────────────────────────────
export const CAMPAIGN_DECISION_KINDS = ['strategy', 'reallocation', 'escalation', 'halt'] as const;
export type CampaignDecisionKind = typeof CAMPAIGN_DECISION_KINDS[number];

export const CAMPAIGN_DECISION_LABELS: Record<CampaignDecisionKind, string> = {
    strategy: 'Strategy',
    reallocation: 'Reallocation',
    escalation: 'Escalation',
    halt: 'Halt',
};

export const CAMPAIGN_DECISION_STATUSES = ['pending', 'approved', 'rejected', 'expired', 'superseded'] as const;
export type CampaignDecisionStatus = typeof CAMPAIGN_DECISION_STATUSES[number];

/**
 * How long a decision stays approvable, by kind.
 *
 * Every decision expires, because every decision is built on evidence with a shelf life. A halt
 * expires fastest: "stop spending on this, it is not working" is a statement about right now, and
 * approving a three-week-old halt applies a judgement to a campaign that has since changed.
 */
export const DECISION_TTL_DAYS: Record<CampaignDecisionKind, number> = {
    strategy: 14,
    reallocation: 7,
    escalation: 3,
    halt: 2,
};

// ── Narrowing helpers (untyped JSON bodies, DB rows) ─────────────────────────
const MODES = new Set<string>(CAMPAIGN_MODES);
const STATUSES = new Set<string>(CAMPAIGN_STATUSES);
const ACTIONS = new Set<string>(CAMPAIGN_ORDER_ACTIONS);
const KINDS = new Set<string>(CAMPAIGN_DECISION_KINDS);
const METRICS = new Set<string>(CAMPAIGN_OUTCOME_METRICS);

export const isCampaignMode = (v: unknown): v is CampaignMode => typeof v === 'string' && MODES.has(v);
export const isCampaignStatus = (v: unknown): v is CampaignStatus => typeof v === 'string' && STATUSES.has(v);
export const isOrderAction = (v: unknown): v is CampaignOrderAction => typeof v === 'string' && ACTIONS.has(v);
export const isDecisionKind = (v: unknown): v is CampaignDecisionKind => typeof v === 'string' && KINDS.has(v);
export const isOutcomeMetric = (v: unknown): v is CampaignOutcomeMetric => typeof v === 'string' && METRICS.has(v);

/** An outcome a tenant may actually pick — excludes the ones nothing can count yet. */
export function isSelectableOutcomeMetric(v: unknown): v is CampaignOutcomeMetric {
    return isOutcomeMetric(v) && !UNAVAILABLE_OUTCOME_METRICS.includes(v);
}
