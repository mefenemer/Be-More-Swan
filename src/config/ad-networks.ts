// src/config/ad-networks.ts
// Phase 3 of docs/campaign-orchestrator-plan.md — the paid rails, built DARK.
//
// Vocabulary, thresholds and the feature key. No I/O, no adapters: this file is what the
// optimiser, the registry and the HTTP boundary all agree about.
//
// ── "Dark" is a design, not a disclaimer ────────────────────────────────────────────────────────
// Everything in Phase 3 is built against an adapter interface with a MOCK implementation, because
// the real one cannot exist yet: LinkedIn's Marketing Developer Platform is a product application
// that has never been made, Meta's business verification is incomplete, and there is no Google Ads
// developer token in this codebase. None of those are engineering problems and none of them have a
// date (plan §1.1).
//
// So the lock is structural rather than a flag someone can flip by accident:
//
//   1. `PAID_ADS_FEATURE` is a plan feature, DEFAULT OFF — off being the ABSENCE of the key, so no
//      environment starts exposed and no seed row is required. Same shape as `strategy_agent`.
//   2. The adapter registry is EMPTY in production (src/utils/ad-networks/registry.ts). Even with
//      the feature on, there is nothing to stage a campaign onto, and the boundary says so in a
//      sentence naming the blocker.
//
// Point 2 is the one that matters. A feature flag protects against a decision; an empty registry
// protects against a mistake. `follower-counts-availability` and `goals-steer-generation` were both
// controls that rendered, promised, and could never return a value — the difference here is that
// the code path physically terminates in "no ad network is connected" rather than in a silent zero.

/**
 * Plan feature gating the entire paid surface. DEFAULT OFF, absence = off.
 *
 * Deliberately NOT reusing `strategy_agent` or a tier check. Spending a customer's money on an
 * external ad account is the largest blast radius in the product — larger than an ICP pivot, which
 * only redirects who we email — and it deserves an entitlement someone granted on purpose.
 */
export const PAID_ADS_FEATURE = 'paid_ads';

// ── Networks ────────────────────────────────────────────────────────────────────────────────────

/**
 * Networks the code knows how to model. Being listed here does NOT mean one is reachable — see
 * the registry. This is the vocabulary for `campaign_links.network` and `ad_variants.network`.
 */
export const AD_NETWORKS = ['linkedin', 'meta', 'google', 'mock'] as const;
export type AdNetwork = typeof AD_NETWORKS[number];

/**
 * How each network writes its own name.
 *
 * ⚠️ Not derivable from the key. CSS `capitalize` turns "linkedin" into "Linkedin", which is
 * simply the wrong name for the company — and getting a partner's name wrong on the one screen
 * that explains why we cannot use them yet is a poor look.
 */
export const AD_NETWORK_LABELS: Record<string, string> = {
    linkedin: 'LinkedIn',
    meta: 'Meta',
    google: 'Google Ads',
    mock: 'Mock network',
};

/** Why each real network is unreachable, in the words the surface shows. */
export const AD_NETWORK_BLOCKERS: Record<string, string> = {
    // ⚠️ Development Tier WAS granted (2026-09-01, app 247000116) — read-only on unlimited ad
    // accounts, EDIT on at most five. So this sentence is about the cap, not about access: we
    // cannot offer it to every workspace until Standard Tier, and promising it to the sixth
    // customer would be a control that works for everyone but them.
    linkedin: 'LinkedIn advertising is in limited testing. Our current access lets us manage only a handful of ad accounts, so it is not open to every workspace yet.',
    meta: 'Meta advertising needs business verification and the ads_management permission, neither of which is approved yet.',
    google: 'Google Ads needs a developer token, which this workspace does not hold.',
};

// ── Variant lifecycle ───────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ `staged` is not `paused`, and the distinction is the whole human-in-the-loop story.
 *
 * `staged`  — built by the assistant and pushed to the network as PAUSED. Never spent anything.
 * `active`  — a human approved it. This is the only state that costs money.
 * `paused`  — it ran and was stopped, by the optimiser or by a person.
 *
 * Collapsing `staged` and `paused` into one value would make "never launched" and "launched and
 * stopped" indistinguishable in every report, and would let a resume button restart something that
 * was never approved in the first place.
 */
export const AD_VARIANT_STATUSES = ['staged', 'active', 'paused', 'archived', 'rejected'] as const;
export type AdVariantStatus = typeof AD_VARIANT_STATUSES[number];

/** Why a variant was paused. A GROUP BY key, so closed. */
export const PAUSE_REASONS = ['creative_fatigue', 'cost_per_outcome', 'budget_exhausted', 'human', 'control_lost'] as const;
export type PauseReason = typeof PAUSE_REASONS[number];

export const PAUSE_REASON_LABELS: Record<PauseReason, string> = {
    creative_fatigue: 'Click-through rate fell well below its own average',
    cost_per_outcome: 'Each result was costing more than the ceiling you set',
    budget_exhausted: 'The campaign reached its spending limit',
    human: 'You paused it',
    control_lost: 'We lost the connection to the ad account and stopped it as a precaution',
};

// ── Optimiser thresholds ────────────────────────────────────────────────────────────────────────

/**
 * How far below its own 7-day average a variant's CTR must fall before it is judged fatigued.
 *
 * 0.40 comes straight from the brief. The number is not the interesting part — the sample floors
 * below are.
 */
export const CTR_FATIGUE_DROP = 0.40;

/** The moving-average window, in days. */
export const FATIGUE_WINDOW_DAYS = 7;

/**
 * ⚠️ THE SAMPLE FLOORS ARE THE RULE. Without them the fatigue check fires on noise for every new
 * campaign, which is exactly when a user is watching most closely.
 *
 * The arithmetic: B2B ad CTR runs around 0.4%. Over 500 impressions that is 2 clicks, so a single
 * click's difference moves the measured CTR by 50% — the rule would trip on one person not
 * clicking. `campaign-proposer.ts` already learned this with MIN_POSTS_FOR_AVERAGE: with a handful
 * of samples the worst performer is far below the mean BY CONSTRUCTION, so a threshold on a small
 * sample is a random number generator with a plausible name.
 *
 * Both floors must be met, and they are checked against the BASELINE window, not today.
 */
export const MIN_IMPRESSIONS_FOR_FATIGUE = 2000;
export const MIN_CLICKS_FOR_FATIGUE = 10;

/**
 * Minimum days of history before the optimiser may judge a variant at all.
 *
 * Separate from the impression floor because a variant can burn through 2,000 impressions in an
 * hour on a large budget, and one hour is not a trend — it is the time of day.
 */
export const MIN_DAYS_FOR_FATIGUE = 3;

/**
 * How stale the optimiser's last run may be before a paid campaign halts itself.
 *
 * ⚠️ THIS EXISTS BECAUSE A DEAD CRON IS INVISIBLE HERE. Two nightly sweeps in this codebase never
 * ran for weeks and nothing noticed; GitHub's scheduler drops the large majority of five-minute
 * cron ticks (written that way on purpose — the slash-star form would close this comment). For
 * organic work a missed run is a delay. For paid work it means the kill switch does not fire and
 * money keeps leaving the customer's account with nobody watching — so the campaign must fail
 * CLOSED. 26 hours gives a daily job a comfortable margin without letting a second missed day pass.
 */
export const OPTIMISER_STALE_HOURS = 26;

// ── Narrowing helpers ───────────────────────────────────────────────────────────────────────────

const NETWORKS = new Set<string>(AD_NETWORKS);
const VARIANT_STATUSES = new Set<string>(AD_VARIANT_STATUSES);
const REASONS = new Set<string>(PAUSE_REASONS);

export const isAdNetwork = (v: unknown): v is AdNetwork => typeof v === 'string' && NETWORKS.has(v);
export const isAdVariantStatus = (v: unknown): v is AdVariantStatus => typeof v === 'string' && VARIANT_STATUSES.has(v);
export const isPauseReason = (v: unknown): v is PauseReason => typeof v === 'string' && REASONS.has(v);
