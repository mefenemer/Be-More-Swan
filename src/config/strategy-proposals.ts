// src/config/strategy-proposals.ts
// Phase 5 — the Strategy Agent's closed vocabularies and change envelope.
//
// Design: docs/lead-generator-revenue-engine-plan.md §7, docs/strategy-agent-plan.md §3 + §5.
//
// Everything here is a CONSTRAINT, not a default. The proposer is LLM-driven and its input includes
// text written by third parties (prospect replies, edit diffs) that arrives through a public
// webhook, so the guarantee that a proposal is safe cannot come from the prompt — it comes from the
// model's output being validated against these frozen maps and discarded when it does not match.
//
// ⚠️ `EDIT_REASONS` and `MIN_EDIT_SAMPLE` deliberately live in src/config/template-feedback.ts,
// where the writer that produces the evidence already validates against them. The plan's file table
// listed them here; duplicating them would recreate exactly the drift the three-way sync test
// exists to catch. Import them from there.

// ── Sources ──────────────────────────────────────────────────────────────────

/**
 * Which producer created a proposal.
 *
 * `MIN_SAMPLE` means something different per source (20 closed deals vs 5 human edits), the evidence
 * blob has a different shape, and the review screen must label which is which — a user should never
 * be shown "34 outcomes" when the number is edits.
 *
 * `human` is not a proposer. It is the synthetic source used when §2.6's "Save as the new default"
 * routes a human's own edit through applyStrategyChange(), so a human save and an agent pivot share
 * one apply path, one audit row and one rollback (§5.4).
 */
export const PROPOSAL_SOURCES = ['win_loss', 'edit_pattern', 'human'] as const;
export type ProposalSource = typeof PROPOSAL_SOURCES[number];

/** Sources produced by the weekly cron. `human` is excluded — it is created on a user's click. */
export const AGENT_SOURCES: readonly ProposalSource[] = ['win_loss', 'edit_pattern'];

export const PROPOSAL_STATUSES = ['pending', 'applied', 'rejected', 'expired'] as const;
export type ProposalStatus = typeof PROPOSAL_STATUSES[number];

// ── Reject vocabulary (§7.1) ─────────────────────────────────────────────────

/**
 * Why a human declined a proposal.
 *
 * CLOSED for the same reason `LOSS_REASONS` is: **a reject reason is an input, not a record.** The
 * next run's prompt receives prior rejections, so declining teaches the loop rather than being a
 * dead end — and free text is unclusterable, which would make that feedback worthless.
 */
export const REJECT_REASONS = [
    'sample_unrepresentative',
    'already_tried',
    'wrong_causation',
    'off_brand',
    'bad_timing',
    'too_narrow',
    'too_broad',
    'other',
] as const;
export type RejectReason = typeof REJECT_REASONS[number];

export const REJECT_REASON_LABELS: Record<RejectReason, string> = {
    sample_unrepresentative: 'The sample is not representative',
    already_tried: 'We tried this; it did not work',
    wrong_causation: 'The correlation is not causal',
    off_brand: 'Conflicts with our positioning',
    bad_timing: 'Seasonal or temporary effect',
    too_narrow: 'Right direction, too narrow',
    too_broad: 'Right direction, too broad',
    other: 'Something else',
};

/** What each rejection tells the next run — shown in the UI so the choice is not arbitrary. */
export const REJECT_REASON_EFFECTS: Record<RejectReason, string> = {
    sample_unrepresentative: 'Raises the sample size needed for this segment',
    already_tried: 'Suppresses this change permanently',
    wrong_causation: 'Fed back as a counter-example',
    off_brand: 'Added as a standing constraint',
    bad_timing: 'Re-proposed after the window',
    too_narrow: 'Re-proposed with a wider scope',
    too_broad: 'Re-proposed with a tighter scope',
    other: 'Your note is kept for you — it is not fed to the model',
};

/**
 * Rejections fed back into the next run's prompt.
 *
 * `other` is excluded deliberately: its note is unstructured text, and one org's idiosyncratic
 * phrasing in a prompt is poison rather than signal (§7.1). The note is still stored and still
 * shown to humans — it just never reaches the model.
 */
export const REJECT_REASONS_FED_TO_MODEL: readonly RejectReason[] =
    REJECT_REASONS.filter((r) => r !== 'other');

// ── The change envelope (§7.3, §5.1) ─────────────────────────────────────────

/** Where applyStrategyChange() writes a field, and what shape its value takes. */
export interface TunableField {
    /** Display label for the review screen. */
    label: string;
    /** One line explaining what the field steers, shown under the diff. */
    description: string;
    /**
     * Which record holds it.
     *   'onboarding' → aiAssistants.onboardingContext[key] (recompiles the blueprint)
     *   'campaign'   → discoveryCampaigns[key] for the assistant's active campaigns
     */
    store: 'onboarding' | 'campaign';
    /** The onboardingContext key, or the discovery_campaigns column. */
    key: string;
    /** 'text' → a string; 'json' → an object or array. Validated before persist AND before apply. */
    valueType: 'text' | 'json';
}

/**
 * THE ALLOW-LIST. `targetField` is never accepted as a free string from the model — it is a key
 * lookup against this frozen map, and anything absent is rejected rather than clamped.
 *
 * The optimizer's precedent is already right here (`if (!AUTONOMOUS_TUNABLE_FIELDS[field]) continue`)
 * and it is what makes the NEVER list below real: a prompt instruction not to touch guardrails is a
 * suggestion; a key lookup against a frozen map is a rule.
 */
export const STRATEGY_TUNABLE_FIELDS: Record<string, TunableField> = {
    target_persona: {
        label: 'Target Persona',
        description: 'Who the discovery engine looks for — the demographics, industries and pain signals it matches against.',
        store: 'campaign',
        key: 'targetPersona',
        valueType: 'json',
    },
    discovery_query_themes: {
        label: 'Discovery Query Themes',
        description: 'The themes the search queries are built from, before they are turned into individual searches.',
        store: 'onboarding',
        key: 'discoveryQueryThemes',
        valueType: 'json',
    },
    outreach_playbook: {
        label: 'Outreach Playbook',
        description: 'How the opening email is written — the angle, the structure and what it leads with.',
        store: 'onboarding',
        key: 'outreachPlaybook',
        valueType: 'text',
    },
    objection_playbook: {
        label: 'Objection Playbook',
        description: 'How common objections are answered when a prospect pushes back.',
        store: 'onboarding',
        key: 'objectionPlaybook',
        valueType: 'json',
    },
    lead_score_weightings: {
        label: 'Lead Score Weightings',
        description: 'How much each signal counts toward a lead\'s score, and therefore its rating.',
        store: 'onboarding',
        key: 'leadScoreWeightings',
        valueType: 'json',
    },
};

/**
 * Fields the Strategy Agent may NEVER write, named explicitly rather than merely omitted.
 *
 * ⚠️ `deal_guardrails` DOES NOT EXIST YET — Phase 4 is unbuilt. It is named here anyway so that
 * Phase 4 cannot ship a table the agent is silently permitted to write. An allow-list protects by
 * omission, which is a protection nobody can see; this list is what a reviewer of the Phase 4 PR
 * will actually find.
 *
 * The principle: **an agent must never widen its own financial or safety envelope.**
 */
export const STRATEGY_FORBIDDEN_FIELDS: Record<string, string> = {
    deal_guardrails: 'Floor price, concessions and non-negotiables (Phase 4 — must never be agent-writable)',
    autonomy_level: 'How much the agent may do without asking',
    suppression_list: 'Who must never be contacted',
    do_not_contact: 'Per-lead contact prohibitions',
    spend_guardrails: 'Discovery cost, token and volume ceilings',
};

// ── Thresholds ───────────────────────────────────────────────────────────────

/**
 * Terminal outcomes required per segment before the win/loss analyser will propose (§7.1).
 *
 * Kept at the epic's figure rather than lowered to make the feature visible sooner. A wrong pivot
 * from n=8 is worse than no pivot: acting on a step function produces oscillation, not learning,
 * which is the failure the goal optimizer already documents. Small orgs are served by the
 * edit-pattern proposer, whose sample unit is reachable far sooner.
 */
export const MIN_SAMPLE = 20;

/**
 * Days a pending proposal stays actionable before the expiry sweep lapses it.
 *
 * 14: long enough that a fortnight's holiday does not silently lose a proposal, short enough that
 * `previousValue` is still current when it is applied — a stale snapshot is what makes Apply
 * destructive rather than reversible.
 */
export const PROPOSAL_EXPIRY_DAYS = 14;

/**
 * The plan feature that reveals the Strategy tab and lets the proposers run.
 *
 * ⚠️ DEFAULT OFF, and off is the absence of the key — `hasFeatureByOrg` treats a missing key as
 * false, so no seed row is needed and no environment starts exposed.
 *
 * Deliberately NOT `tierAllows('autonomous')`. That gate admits the goal optimizer, which rewrites
 * brand voice for an org's own content. §7.1 draws the distinction explicitly — "the difference is
 * blast radius" — between that and an ICP pivot that redirects cold outreach at real strangers.
 * One gate for both collapses the exact distinction this phase is built around, and does it
 * silently, because nobody re-reads a tier check when adding a feature to it.
 *
 * The same reasoning §7.1 uses to defer `auto_apply_below_confidence` applies to who can see this:
 * zero proposals have ever existed, so nobody knows yet what they look like. Enable it for one org,
 * read real proposals, then widen with examples in hand. Too cautious costs a config row; too open
 * means a customer's first encounter with the feature is an agent proposing they retarget their
 * outbound at a different persona, on a sample nobody has inspected.
 */
export const STRATEGY_AGENT_FEATURE = 'strategy_agent';

// ── Guards ───────────────────────────────────────────────────────────────────

export function isProposalSource(v: unknown): v is ProposalSource {
    return typeof v === 'string' && (PROPOSAL_SOURCES as readonly string[]).includes(v);
}

export function isProposalStatus(v: unknown): v is ProposalStatus {
    return typeof v === 'string' && (PROPOSAL_STATUSES as readonly string[]).includes(v);
}

export function isRejectReason(v: unknown): v is RejectReason {
    return typeof v === 'string' && (REJECT_REASONS as readonly string[]).includes(v);
}

/** The allow-list entry for a target field, or null when it is not tunable. Never throws. */
export function tunableField(field: unknown): TunableField | null {
    if (typeof field !== 'string') return null;
    return Object.prototype.hasOwnProperty.call(STRATEGY_TUNABLE_FIELDS, field)
        ? STRATEGY_TUNABLE_FIELDS[field]
        : null;
}

/**
 * Does `value` match the shape the field declares?
 *
 * Checked before persist AND again before apply, because the two happen days apart and the row is
 * editable in between by anything with database access. A `text` field handed an object would be
 * written into the blueprint as "[object Object]".
 */
export function isValidValueFor(field: TunableField, value: unknown): boolean {
    if (field.valueType === 'text') {
        return typeof value === 'string' && value.trim().length > 0;
    }
    // 'json' — an object or an array, but not null (indistinguishable from "unset" downstream).
    return typeof value === 'object' && value !== null;
}
