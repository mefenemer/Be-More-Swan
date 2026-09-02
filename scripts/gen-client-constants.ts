// scripts/gen-client-constants.ts
//
// Generates src/generated/platform-constants.js — the browser's copy of the platform facts that
// live in src/config/platform-formats.ts.
//
// ── Why this exists ─────────────────────────────────────────────────────────────────────────────
// workspace.html is a static, unbundled page: it cannot `import` from src/, so every shared constant
// has historically been retyped into it by hand. Those hand copies drift, silently, and the drift is
// always a user-visible bug rather than a crash:
//   • the platform list drifted → Threads and YouTube were dropped from a post with no error
//   • the media-mandatory rule drifted → the composer let a YouTube post through with no video
//   • charLimit is mirrored as _GPW_CHAR_LIMITS
//   • canPublishVideo was about to become the fourth copy
//
// Generating the mirror instead of writing it makes the drift impossible: one source of truth, and
// tests/client-constants-fresh.test.ts fails if this file's output stops matching what's committed.
//
// Run:  npm run gen:constants     (and commit the result — there is no build step on deploy)

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLATFORM_FORMATS, SOCIAL_PLATFORMS } from '../src/config/platform-formats';
import { POST_FORMATS } from '../src/config/post-formats';
import { SCHEDULE_ACTIVE_STATUSES } from '../src/config/post-status';
import { DEAD_CONNECTION_STATUSES } from '../src/config/connection-status';
import {
    OUTCOMES, OUTCOME_LABELS, LOSS_REASONS, LOSS_REASON_LABELS, OUTCOMES_REQUIRING_LOSS_REASON,
} from '../src/config/revenue-events';
import { EDIT_REASONS, EDIT_REASON_LABELS } from '../src/config/template-feedback';
import { LEAD_REJECT_REASONS, LEAD_REJECT_REASON_LABELS } from '../src/config/lead-reject-reasons';
import {
    CAMPAIGN_REJECT_REASONS, CAMPAIGN_REJECT_REASON_LABELS,
} from '../src/config/campaign-reject-reasons';
import {
    CAMPAIGN_STATUS_LABELS, CAMPAIGN_ORDER_STATUS_LABELS, CAMPAIGN_DECISION_LABELS,
    CAMPAIGN_OUTCOME_LABELS, ORDER_ACTION_SPECS, UNAVAILABLE_OUTCOME_METRICS,
    CAMPAIGN_LINK_MEDIUMS,
} from '../src/config/campaign-vocab';
import { PAUSE_REASON_LABELS } from '../src/config/ad-networks';
import {
    POSTING_CADENCES, NUMBER_WORDS, DEFAULT_POSTING_FREQUENCY, postsPerWeekFor, readCadence,
    MONDAY_FIRST, DEFAULT_POSTING_DAYS, DEFAULT_POSTING_TIMES, selectWeeklySlots,
} from '../src/config/posting-cadence';
import {
    LEAD_RECIPIENT_PATHS, resolveLeadRecipient, hasOutreachDraft, isLeadDeliverable,
    leadOutreachStage, isInOutreachReview,
} from '../src/config/lead-recipient';
import {
    ROLE_EMAIL_PREFIXES, roleOrPersonal, classifyEmailKind,
    EMAIL_SOURCE_LABELS, emailSourceLabel, needsPersonalInboxConfirmation,
} from '../src/config/lead-email-kind';
import { LEAD_OUTREACH_CHIPS, leadOutreachState } from '../src/config/lead-outreach-state';
import {
    ASSISTANT_COLORS, ASSISTANT_COLOR_VALUES, ASSISTANT_COLOR_NEUTRAL,
} from '../src/config/assistant-colors';
import {
    LEAD_RETENTION_DAYS, RETENTION_FIELD, RETENTION_DELETED_FIELD, RETENTION_REASONS,
    RETENTION_REASON_LABELS, RETENTION_REASON_NOTES, RETENTION_NOTICE, RETENTION_DELETED_NOTICE,
    isRetentionDeleted, retentionReasonOf, retentionClockStart,
    retentionDaysRemaining, retentionCountdownLabel, retentionUrgency,
} from '../src/config/lead-retention';
import { RATING_BANDS } from '../src/config/icp-profile';
import { LEAD_RATING_CHIPS, LEAD_RATING_CHIP_UNKNOWN } from '../src/config/lead-rating-chips';
import {
    BLOG_FONTS, BLOG_FONT_CATEGORIES, DEFAULT_FONT_STACK, googleFontUrl,
} from '../src/config/blog-fonts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const OUTPUT_PATH = join(root, 'src', 'generated', 'platform-constants.js');

/** Build the file's contents. Exported so the freshness test can compare without writing. */
export function renderClientConstants(): string {
    const platforms = SOCIAL_PLATFORMS.map(id => {
        const f = PLATFORM_FORMATS[id];
        return {
            id,
            label: f.label,
            charLimit: f.charLimit,
            aspectRatio: f.aspectRatio,
            mediaMandatory: f.mediaMandatory,
            mediaKind: f.mediaKind,
            canPublishVideo: f.canPublishVideo,
            linksClickable: f.linksClickable,
            defaultPostFormat: f.defaultPostFormat,
        };
    });

    const rows = platforms.map(p => `    ${JSON.stringify(p)},`).join('\n');

    // Blog fonts, from src/config/blog-fonts.ts. The stylesheet URL is RESOLVED here rather than
    // rebuilt in the browser: widget.js, blog-seo.ts and the picker must all agree on the exact
    // string, because save-widget-config validates the stored fontUrl by exact match against it.
    const fontRows = BLOG_FONTS.map(f => JSON.stringify({
        label: f.label,
        stack: f.stack,
        category: f.category,
        url: googleFontUrl(f),
    })).map(j => `    ${j},`).join('\n');

    // The editor's per-format records. Short keys because this list is rendered per keystroke in a
    // page with no build step — and because the shape predates the generator, so keeping it means
    // _pceRenderFormats/_pceRenderFormatRules did not have to change.
    //
    // `availability` is mapped to the vocabulary workspace.html already branches on: it treats
    // anything that is neither 'live' nor 'planned' as unschedulable, and called that 'blocked'.
    const formatRows = POST_FORMATS.map(f => JSON.stringify({
        k: f.key,
        p: f.platform,
        n: f.label,
        d: f.blurb,
        m: f.media,
        ar: f.aspectRatios[0] ?? '',
        min: f.minItems,
        max: f.maxItems,
        cl: f.charLimit,
        // Duration ceiling, where the catalogue declares one. Emitted so the composer can state a
        // derived format without a round trip — and so it reads the SAME number the server routes
        // on, rather than a second copy typed into the page.
        ...(f.maxDurationS != null ? { maxd: f.maxDurationS } : {}),
        a: f.availability === 'live' ? 'live' : f.availability === 'planned' ? 'planned' : 'blocked',
        ...(f.unavailableReason ? { why: f.unavailableReason } : {}),
    })).map(j => `    ${j},`).join('\n');

    return `// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Written by scripts/gen-client-constants.ts from src/config/platform-formats.ts.
// Run \`npm run gen:constants\` after changing platform facts, and commit the result: the site has no
// build step, so this file IS what the browser loads.
//
// It exists because workspace.html cannot import from src/. Every constant here used to be retyped
// into that page by hand, and every hand copy eventually drifted — dropping platforms from posts,
// or letting through drafts the server would refuse. Read from window.PlatformConstants instead of
// writing another copy.
(function () {
  'use strict';

  var PLATFORMS = [
${rows}
  ];

  // Every post format, from src/config/post-formats.ts. workspace.html reads this as _PCE_FORMATS.
  var POST_FORMATS = [
${formatRows}
  ];

  // scheduled_posts statuses whose schedule is LIVE, from src/config/post-status.ts. A draft's
  // publish_date is only a proposal until someone presses Schedule, so the calendar renders these
  // and nothing else.
  var SCHEDULE_ACTIVE_STATUSES = ${JSON.stringify(SCHEDULE_ACTIVE_STATUSES)};
  var scheduleActive = {};
  for (var s = 0; s < SCHEDULE_ACTIVE_STATUSES.length; s++) scheduleActive[SCHEDULE_ACTIVE_STATUSES[s]] = true;

  // system_connections statuses that mean "reconnect required", from
  // src/config/connection-status.ts. The hand-written copy of this list in integrations.js omitted
  // 'token_expired' — the value the Meta paths write — so a dead Facebook connection rendered as
  // "Connected" until someone noticed posts had stopped going out.
  var DEAD_CONNECTION_STATUSES = ${JSON.stringify(DEAD_CONNECTION_STATUSES)};
  var deadStatus = {};
  for (var d = 0; d < DEAD_CONNECTION_STATUSES.length; d++) deadStatus[DEAD_CONNECTION_STATUSES[d]] = true;

  var byId = {};
  for (var i = 0; i < PLATFORMS.length; i++) byId[PLATFORMS[i].id] = PLATFORMS[i];

  window.PlatformConstants = {
    /** Every platform we can draft and publish for, in a stable order. */
    all: PLATFORMS,

    /** Every post format, in catalogue order. Shape matches the editor's _PCE_FORMATS records. */
    formats: POST_FORMATS,

    /** scheduled_posts statuses that mean "committed to publish", in canonical order. */
    scheduleActiveStatuses: SCHEDULE_ACTIVE_STATUSES,

    /** system_connections statuses that mean the credential is dead and must be reconnected. */
    deadConnectionStatuses: DEAD_CONNECTION_STATUSES,

    /**
     * True when a connection's status means "reconnect required". Test the status against THIS
     * rather than listing values inline: the vocabulary is per-writer and has already drifted once.
     */
    isConnectionDead: function (status) {
      return deadStatus[String(status == null ? '' : status)] === true;
    },

    /**
     * True when a post is committed to publish — i.e. it belongs on the Content Calendar. Drafts
     * carry a proposed publish_date from birth; only pressing Schedule makes that date real.
     */
    isScheduleActive: function (status) {
      return scheduleActive[String(status == null ? '' : status)] === true;
    },

    /** One platform's facts. Tolerates legacy 'twitter'; returns null for anything unknown. */
    get: function (id) {
      var key = String(id || '').toLowerCase();
      if (key === 'twitter') key = 'x';
      return byId[key] || null;
    },

    /** Display name ('X', 'YouTube'), falling back to the raw value rather than showing nothing. */
    label: function (id) {
      var p = this.get(id);
      return p ? p.label : String(id || '');
    },

    /** Caption+hashtag cap, or null when the platform is unknown. */
    charLimit: function (id) {
      var p = this.get(id);
      return p ? p.charLimit : null;
    },

    /** Can our PUBLISHER send a video here? A statement about our drivers, not about the network. */
    canPublishVideo: function (id) {
      var p = this.get(id);
      return !!(p && p.canPublishVideo);
    },

    /** Platforms that cannot publish without media, with the kind each one needs. */
    mediaMandatory: function (ids) {
      var out = [];
      for (var i = 0; i < ids.length; i++) {
        var p = this.get(ids[i]);
        if (p && p.mediaMandatory) out.push(p);
      }
      return out;
    },
  };

  // ── Revenue outcomes (Phase 4.5) ──────────────────────────────────────────
  // The closed vocabularies from src/config/revenue-events.ts, for the Data Hub's "Record outcome"
  // control. Generated rather than retyped: these are the GROUP BY keys the Strategy Agent reads,
  // so a drifted copy here would write values the CHECK constraint rejects — and recordEvent()
  // swallows its errors, which makes that failure invisible rather than loud.
  var OUTCOMES = ${JSON.stringify(OUTCOMES)};
  var OUTCOME_LABELS = ${JSON.stringify(OUTCOME_LABELS)};
  var LOSS_REASONS = ${JSON.stringify(LOSS_REASONS)};
  var LOSS_REASON_LABELS = ${JSON.stringify(LOSS_REASON_LABELS)};
  var NEEDS_LOSS_REASON = ${JSON.stringify(OUTCOMES_REQUIRING_LOSS_REASON)};

  // Why a reviewer changed a drafted message (plan §2.6), from src/config/template-feedback.ts.
  // CHECK-constrained server-side, so a drifted copy here would write values the DB rejects.
  var EDIT_REASONS = ${JSON.stringify(EDIT_REASONS)};
  var EDIT_REASON_LABELS = ${JSON.stringify(EDIT_REASON_LABELS)};

  // Why a reviewer rejected a discovered lead, from src/config/lead-reject-reasons.ts. Also
  // CHECK-constrained server-side.
  var LEAD_REJECT_REASONS = ${JSON.stringify(LEAD_REJECT_REASONS)};
  var LEAD_REJECT_REASON_LABELS = ${JSON.stringify(LEAD_REJECT_REASON_LABELS)};

  window.RevenueConstants = {
    /** 'won' | 'lost' | 'disqualified', in canonical order. */
    outcomes: OUTCOMES,

    /** Loss reasons, in canonical order. Closed — free text is unclusterable by design. */
    lossReasons: LOSS_REASONS,

    /** Display label for an outcome, falling back to the raw value rather than showing nothing. */
    outcomeLabel: function (o) {
      return OUTCOME_LABELS[String(o == null ? '' : o)] || String(o == null ? '' : o);
    },

    /** Display label for a loss reason. */
    lossReasonLabel: function (r) {
      return LOSS_REASON_LABELS[String(r == null ? '' : r)] || String(r == null ? '' : r);
    },

    /**
     * True when this outcome cannot be recorded without a loss reason. The server enforces the
     * same rule — this only decides whether the picker is shown.
     */
    needsLossReason: function (o) {
      return NEEDS_LOSS_REASON.indexOf(String(o == null ? '' : o)) !== -1;
    },

    /** Why a reviewer changed a drafted message, from src/config/template-feedback.ts. */
    editReasons: EDIT_REASONS,

    /** Display label for an edit reason. */
    editReasonLabel: function (r) {
      return EDIT_REASON_LABELS[String(r == null ? '' : r)] || String(r == null ? '' : r);
    },

    /** Why a reviewer rejected a lead, from src/config/lead-reject-reasons.ts. */
    leadRejectReasons: LEAD_REJECT_REASONS,

    /** Display label for a lead reject reason. */
    leadRejectReasonLabel: function (r) {
      return LEAD_REJECT_REASON_LABELS[String(r == null ? '' : r)] || String(r == null ? '' : r);
    },
  };

  // ── Campaign vocabulary ───────────────────────────────────────────────────
  // From src/config/campaign-vocab.ts and src/config/campaign-reject-reasons.ts. Generated for
  // the usual reason — the Campaigns tab, the Orders Data Hub, the Decisions Review Queue and the
  // chat proposal card all render these labels, which is four hand copies waiting to drift.
  //
  // The state chips especially: "Throttled" (the agent optimising) and "Paused" (the agent
  // stopping) are distinct facts, and connection-status-vocabulary-drift is what happens when two
  // surfaces quietly disagree about which one a row is in.
  // (Double quotes, not backticks — this comment lives inside the generator's template literal,
  // where a backtick ends the string and the error points at the wrong line entirely.)
  var CAMPAIGN_STATUS_LABELS = ${JSON.stringify(CAMPAIGN_STATUS_LABELS)};
  var CAMPAIGN_ORDER_STATUS_LABELS = ${JSON.stringify(CAMPAIGN_ORDER_STATUS_LABELS)};
  var CAMPAIGN_DECISION_LABELS = ${JSON.stringify(CAMPAIGN_DECISION_LABELS)};
  var CAMPAIGN_OUTCOME_LABELS = ${JSON.stringify(CAMPAIGN_OUTCOME_LABELS)};
  var CAMPAIGN_REJECT_REASONS = ${JSON.stringify(CAMPAIGN_REJECT_REASONS)};
  var CAMPAIGN_REJECT_REASON_LABELS = ${JSON.stringify(CAMPAIGN_REJECT_REASON_LABELS)};
  var UNAVAILABLE_OUTCOME_METRICS = ${JSON.stringify(UNAVAILABLE_OUTCOME_METRICS)};
  var CAMPAIGN_LINK_MEDIUMS = ${JSON.stringify(CAMPAIGN_LINK_MEDIUMS)};
  var PAUSE_REASON_LABELS = ${JSON.stringify(PAUSE_REASON_LABELS)};
  // Only the fields the browser renders. artefactKind/assignedRole stay server-side — the client
  // has no business routing an order, and shipping the routing table would invite it to try.
  var ORDER_ACTIONS = ${JSON.stringify(
      Object.entries(ORDER_ACTION_SPECS).map(([key, s]) => ({
          key, label: s.label, description: s.description,
      })),
  )};

  window.CampaignConstants = {
    /** Display label for a campaign status ('active' → 'Running'). */
    statusLabel: function (s) {
      return CAMPAIGN_STATUS_LABELS[String(s == null ? '' : s)] || String(s == null ? '' : s);
    },

    /** Display label for an order status ('issued' → 'With the assistant'). */
    orderStatusLabel: function (s) {
      return CAMPAIGN_ORDER_STATUS_LABELS[String(s == null ? '' : s)] || String(s == null ? '' : s);
    },

    /** Display label for a decision kind ('halt' → 'Halt'). */
    decisionLabel: function (k) {
      return CAMPAIGN_DECISION_LABELS[String(k == null ? '' : k)] || String(k == null ? '' : k);
    },

    /** Display label for what a campaign counts ('leads' → 'New leads found'). */
    outcomeLabel: function (m) {
      return CAMPAIGN_OUTCOME_LABELS[String(m == null ? '' : m)] || String(m == null ? '' : m);
    },

    /**
     * Outcome metrics a user may actually choose. Excludes the ones nothing counts yet — an
     * outcome that always reads zero looks like a broken campaign, not an unbuilt feature.
     */
    selectableOutcomes: Object.keys(CAMPAIGN_OUTCOME_LABELS).filter(function (m) {
      return UNAVAILABLE_OUTCOME_METRICS.indexOf(m) === -1;
    }),

    /** Why a founder rejected a decision. Closed vocabulary — it is a GROUP BY key. */
    rejectReasons: CAMPAIGN_REJECT_REASONS,

    /** Display label for a reject reason. */
    rejectReasonLabel: function (r) {
      return CAMPAIGN_REJECT_REASON_LABELS[String(r == null ? '' : r)] || String(r == null ? '' : r);
    },

    /** The orders an assistant can be given: [{ key, label, description }]. */
    orderActions: ORDER_ACTIONS,

    /** Display label for an order action, falling back to the raw key. */
    orderActionLabel: function (a) {
      var k = String(a == null ? '' : a);
      for (var i = 0; i < ORDER_ACTIONS.length; i++) if (ORDER_ACTIONS[i].key === k) return ORDER_ACTIONS[i].label;
      return k;
    },

    // Where a tracked link is published. CHECK-constrained in db/campaign-attribution.sql and
    // validated again at the HTTP boundary, so this list is for building the picker only — it is
    // not the guard. Generated rather than hand-copied: a client-side fork of a closed vocabulary
    // is how the browser's private cadence regex quietly disagreed with the scheduler for weeks.
    linkMediums: CAMPAIGN_LINK_MEDIUMS,

    // Why an ad was paused, in words. ⚠️ An ad that stopped without saying why is the assistant
    // making a decision the user cannot argue with — so this must never fall back to a raw enum.
    pauseReasonLabel: function (r) {
      var k = String(r == null ? "" : r);
      return PAUSE_REASON_LABELS[k] || k;
    },
  };

  // ── Posting cadence ───────────────────────────────────────────────────────
  // From src/config/posting-cadence.ts. postsPerWeekFor and readCadence below are the REAL
  // functions, stringified at generation time — not reimplementations. That matters more here
  // than anywhere else in this file: the browser had its own private cadence regex, it disagreed
  // with the scheduler, and a live tenant's autopilot sat dead for weeks while the dashboard
  // reported it as running. There is now one parser and the browser cannot fork it again.
  //
  // Their free variables (POSTING_CADENCES, NUMBER_WORDS, DEFAULT_POSTING_FREQUENCY,
  // postsPerWeekFor) resolve to the declarations directly above, so the names must match.
  var POSTING_CADENCES = ${JSON.stringify(POSTING_CADENCES)};
  var NUMBER_WORDS = ${JSON.stringify(NUMBER_WORDS)};
  var DEFAULT_POSTING_FREQUENCY = ${JSON.stringify(DEFAULT_POSTING_FREQUENCY)};
  var MONDAY_FIRST = ${JSON.stringify(MONDAY_FIRST)};
  var DEFAULT_POSTING_DAYS = ${JSON.stringify(DEFAULT_POSTING_DAYS)};
  var DEFAULT_POSTING_TIMES = ${JSON.stringify(DEFAULT_POSTING_TIMES)};
  var postsPerWeekFor = ${postsPerWeekFor.toString()};
  var readCadence = ${readCadence.toString()};
  var selectWeeklySlots = ${selectWeeklySlots.toString()};

  window.PostingCadence = {
    /** The catalogue, in canonical order. Render pickers from THIS, never a retyped list. */
    all: POSTING_CADENCES,

    /** Posts per week for a stored posting_frequency. 0 = nothing will be scheduled. */
    postsPerWeekFor: postsPerWeekFor,

    /**
     * { postsPerWeek, kind } where kind is 'scheduled' | 'on_demand' | 'unrecognised'.
     *
     * Use this, not a rate of 0, to decide what to TELL the user: 'on_demand' is their choice,
     * 'unrecognised' is us failing to understand a schedule they asked for. Never render the
     * second as the first.
     */
    read: readCadence,

    /** True when the scheduler will draft ahead for this cadence. */
    isActive: function (value) {
      return readCadence(value).kind === 'scheduled';
    },

    /**
     * The weekly pattern the SCHEDULER will actually use: [{ day, time }, ...].
     *
     * Ticked days are ELIGIBLE days, not guaranteed ones — the cadence sets the rate and this
     * function picks which of the eligible days carry it. "Weekly" + Mon-Fri is ONE post on
     * Wednesday, not five. Every surface that shows a user their schedule must render THIS, not
     * the raw posting_days array, or it promises four posts a week that will never be written.
     */
    weeklyPattern: function (days, times, frequency) {
      return selectWeeklySlots(days || [], times || [], postsPerWeekFor(frequency));
    },
  };

  // ── Lead recipient ────────────────────────────────────────────────────────
  // From src/config/lead-recipient.ts, stringified — the REAL functions, for the same reason as
  // the cadence parser above. This rule decides who receives a cold email: the Review Queue prints
  // the recipient from it, the server filters the queue with it, and send_outreach sends to it. A
  // browser copy that forked would show one address above the Approve button and mail another.
  //
  // Free variables (LEAD_RECIPIENT_PATHS, resolveLeadRecipient, hasOutreachDraft) resolve to the
  // declarations directly above, so the names must match.
  var LEAD_RECIPIENT_PATHS = ${JSON.stringify(LEAD_RECIPIENT_PATHS)};
  var resolveLeadRecipient = ${resolveLeadRecipient.toString()};
  var hasOutreachDraft = ${hasOutreachDraft.toString()};
  var isLeadDeliverable = ${isLeadDeliverable.toString()};

  window.LeadRecipient = {
    /** The address a send would actually use, or null when the lead cannot be reached. */
    resolve: resolveLeadRecipient,

    /** Does this lead carry a drafted email with a body? Cold leads deliberately carry none. */
    hasDraft: hasOutreachDraft,

    /**
     * Is there an email here for a human to sign off? This is what stocks the Review Queue —
     * keep it identical to the server's ?deliverable=1 filter or the badge and the list disagree.
     */
    isDeliverable: isLeadDeliverable,
  };

  // ── Lead outreach stage ───────────────────────────────────────────────────
  // From src/config/lead-recipient.ts, stringified. This is the human override on top of the
  // predicate directly above: which of the two lead surfaces — Enrichment, or the Outreach tab's
  // Review column — a person has said this lead belongs on. The buttons that write it and the SQL
  // that reads it are on opposite sides of the wire, so a hand copy that drifted would leave a
  // lead in a column its own button says it is not in.
  //
  // isInOutreachReview closes over isLeadDeliverable, declared just above — keep the order.
  var leadOutreachStage = ${leadOutreachStage.toString()};
  var isInOutreachReview = ${isInOutreachReview.toString()};

  window.LeadOutreachStage = {
    /** 'review' | 'triage' | null — what a PERSON said, never inferred. */
    of: leadOutreachStage,

    /**
     * Does this lead belong in the Outreach tab's Review column? A stage wins outright in both
     * directions; with none, deliverability decides. Keep identical to the server's stage-aware
     * ?deliverable=1 filter.
     */
    isInReview: isInOutreachReview,
  };

  // ── Lead retention (the 30-day clock) ─────────────────────────────────────
  // From src/config/lead-retention.ts, stringified — the REAL countdown, for the sharpest version
  // of the reason the two blocks above are mirrored: this number sits beside a lead and tells the
  // user how long they have to act before it is moved out of their pipeline automatically. A
  // browser copy that drifted from the sweep would count down to the wrong day, and the user would
  // find out by losing a lead on the day the screen said they had three left.
  //
  // The agreement is structural rather than careful: the clock is updated_at on both sides
  // (there is no second stamp to fall out of step — see retentionClockStart's header), and every
  // function below is the same source the server runs.
  //
  // Free variables (RETENTION_FIELD, RETENTION_DELETED_FIELD, LEAD_RETENTION_DAYS,
  // isRetentionDeleted) resolve to the declarations directly above, so the names must match.
  var LEAD_RETENTION_DAYS = ${JSON.stringify(LEAD_RETENTION_DAYS)};
  var RETENTION_FIELD = ${JSON.stringify(RETENTION_FIELD)};
  var RETENTION_DELETED_FIELD = ${JSON.stringify(RETENTION_DELETED_FIELD)};
  var RETENTION_REASONS = ${JSON.stringify(RETENTION_REASONS)};
  var isRetentionDeleted = ${isRetentionDeleted.toString()};
  var retentionReasonOf = ${retentionReasonOf.toString()};
  var retentionClockStart = ${retentionClockStart.toString()};
  var retentionDaysRemaining = ${retentionDaysRemaining.toString()};
  var retentionCountdownLabel = ${retentionCountdownLabel.toString()};
  var retentionUrgency = ${retentionUrgency.toString()};

  window.LeadRetention = {
    /** How long a lead may sit in Outreach ▸ Review or ▸ Archived before it is moved to Deleted. */
    DAYS: LEAD_RETENTION_DAYS,

    /** Has the sweep already moved this lead? Presence of deletedAt is the test. */
    isDeleted: isRetentionDeleted,

    /** Why it was moved — a RETENTION_REASONS key — or null if the lead is still live. */
    reasonOf: retentionReasonOf,

    /** What the Deleted section prints for each reason. */
    REASON_LABELS: ${JSON.stringify(RETENTION_REASON_LABELS)},
    REASON_NOTES: ${JSON.stringify(RETENTION_REASON_NOTES)},

    /**
     * Whole days left, from the record envelope's updatedAt. Null when there is nothing to read,
     * so callers render nothing rather than "NaN days".
     */
    daysRemaining: function (updatedAtIso, now) {
      return retentionDaysRemaining(retentionClockStart(updatedAtIso), now);
    },

    /** "3 days left" / "1 day left" / "Due for deletion" — the exact string every surface shows. */
    countdownLabel: retentionCountdownLabel,

    /** 'none' | 'low' | 'soon' | 'urgent' — how loudly the countdown should be drawn. */
    urgency: retentionUrgency,

    /** The standing notice above the Review and Archived columns. */
    NOTICE: ${JSON.stringify(RETENTION_NOTICE)},

    /** The Deleted section's own header line. */
    DELETED_NOTICE: ${JSON.stringify(RETENTION_DELETED_NOTICE)},
  };

  // ── Lead email kind ───────────────────────────────────────────────────────
  // From src/config/lead-email-kind.ts, stringified — the REAL classifier, and it has to be, for a
  // sharper reason than the two above. The browser writes emailKind now: a user typing an address
  // into Edit lead is the second writer of a field the scraper used to own alone. If the two
  // disagree, the same inbox is a "Role inbox" when scraped and a "Named person" when typed, on a
  // label that stands in for the GDPR footing of contacting it.
  //
  // Free variables (ROLE_EMAIL_PREFIXES, roleOrPersonal) resolve to the declarations directly
  // above, so the names must match. The Set is rebuilt from its members because JSON.stringify
  // renders a Set as {} — a silently empty vocabulary that would classify every address as a person.
  var ROLE_EMAIL_PREFIXES = new Set(${JSON.stringify([...ROLE_EMAIL_PREFIXES])});
  var roleOrPersonal = ${roleOrPersonal.toString()};
  var classifyEmailKind = ${classifyEmailKind.toString()};

  // Provenance vocabulary + the confirmation gate. Mirrored for the same reason as the classifier
  // above: the Review Queue prints the origin and shows the warning, while the SERVER decides
  // whether the send is allowed. A browser copy that forked would show a reassuring line beside a
  // button the server then refuses — or, far worse, stay quiet about an address it will happily
  // send to a named individual whose details were bought.
  var EMAIL_SOURCE_LABELS = ${JSON.stringify(EMAIL_SOURCE_LABELS)};
  var emailSourceLabel = ${emailSourceLabel.toString()};
  var needsPersonalInboxConfirmation = ${needsPersonalInboxConfirmation.toString()};

  window.LeadEmailKind = {
    /** 'role' | 'personal' for a whole address, or null if it is not an address at all. */
    classify: classifyEmailKind,

    /** Same rule, for a bare local part. */
    ofLocalPart: roleOrPersonal,

    /** How to describe where an address came from. '' when there is nothing worth saying. */
    sourceLabel: emailSourceLabel,

    /**
     * Does this address need an explicit "yes, email this named person" first?
     * Keep identical to the server gate in lead-generation.ts — it is the same function.
     */
    needsConfirmation: needsPersonalInboxConfirmation,
  };

  // ── Lead outreach state ────────────────────────────────────────────────────
  // From src/config/lead-outreach-state.ts. Mirrored rather than retyped because THREE surfaces
  // state it — the Review tab's card chip, the Leads tab's Approval column and the banner on an
  // open lead — and a lead reading "Email Sent" in one and "Approved" in another is the same lead
  // described two ways. The predicate is one function so they cannot fork.
  var LEAD_OUTREACH_CHIPS = ${JSON.stringify(LEAD_OUTREACH_CHIPS)};
  var leadOutreachState = ${leadOutreachState.toString()};

  window.LeadOutreach = {
    /** { sent: { label, cls }, drafted: { label, cls } } — the words and colours every surface uses. */
    chips: LEAD_OUTREACH_CHIPS,

    /** 'sent' | 'drafted' | null for a lead's \`data\`. Null means nothing has happened to it yet. */
    state: leadOutreachState,

    /** The chip for a lead's \`data\`, or null. Saves every caller repeating the lookup. */
    chipFor: function (data) {
      var s = leadOutreachState(data);
      return s ? LEAD_OUTREACH_CHIPS[s] : null;
    },
  };

  // ── Lead rating bands ──────────────────────────────────────────────────────
  // The hot/warm/cold definition the SCORING PROMPT uses, mirrored so the UI can explain a chip
  // without retyping the numbers. This is the copy that matters most to keep generated: the bands
  // had already been pasted into three prompts and drifted, and a lead rated "warm" by discovery
  // and "cold" by chat is indistinguishable from an inconsistent model. A tooltip claiming a
  // different threshold from the one that produced the chip would be the same bug, aimed at a user.
  var RATING_BANDS = ${JSON.stringify(RATING_BANDS)};

  // The chip COLOURS, from src/config/lead-rating-chips.ts. Three surfaces draw this chip — the
  // Searches result row, the Leads tab's Rating column and the lead scoring card — and before this
  // was shared they disagreed, so the same lead's rating looked like a different fact per tab.
  var RATING_CHIPS = ${JSON.stringify(LEAD_RATING_CHIPS)};
  var RATING_CHIP_UNKNOWN = ${JSON.stringify(LEAD_RATING_CHIP_UNKNOWN)};

  window.LeadRating = {
    /** [{ rating, min, max, meaning }] — highest band first, exactly as the prompt states them. */
    bands: RATING_BANDS,

    /** { hot|warm|cold: { label, cardLabel, cls, bar } } — the words and colours every surface uses. */
    chips: RATING_CHIPS,

    /**
     * The chip for a rating, never null — an unknown or absent rating gets the neutral chip.
     *
     * ⚠️ Unrated is NOT cold. A CSV import and a pre-scoring record both arrive with no rating, and
     * colouring them as the lowest band would state a verdict the scorer never reached.
     */
    chipFor: function (rating) {
      var c = RATING_CHIPS[rating];
      if (!c) return { label: '', cardLabel: '', cls: RATING_CHIP_UNKNOWN.cls, bar: RATING_CHIP_UNKNOWN.bar };
      return c;
    },

    /** The band a raw 0-100 score falls in, or null when there is no score. */
    bandFor: function (score) {
      // ⚠️ Not a bare Number(): Number(null), Number('') and Number(false) are all 0, so an
      // UNSCORED lead would come back "cold" — a real verdict invented out of missing data, which
      // is the one thing the scoring rules forbid everywhere else in this system.
      if (typeof score !== 'number' && !(typeof score === 'string' && score.trim() !== '')) return null;
      var n = Number(score);
      if (!isFinite(n)) return null;
      for (var i = 0; i < RATING_BANDS.length; i++) {
        if (n >= RATING_BANDS[i].min && n <= RATING_BANDS[i].max) return RATING_BANDS[i];
      }
      return null;
    },

    /**
     * One sentence explaining a rating, for a tooltip. Empty string for an unknown rating, so a
     * caller can put it straight into a title attribute without guarding.
     */
    help: function (rating) {
      var band = null;
      for (var i = 0; i < RATING_BANDS.length; i++) {
        if (RATING_BANDS[i].rating === rating) band = RATING_BANDS[i];
      }
      if (!band) return '';
      var name = band.rating.charAt(0).toUpperCase() + band.rating.slice(1);
      return name + ': scored ' + band.min + '–' + band.max + ' out of 100 against the ideal '
        + 'customer profile from your setup — ' + band.meaning.replace(' + ', ', and ') + '.';
    },
  };

  // ── Blog fonts (src/config/blog-fonts.ts) ────────────────────────────────────────────────────
  // Blog Studio's Font family picker. Carries the CSS stack AND the Google Fonts stylesheet, because
  // choosing a font without fetching it is what made the old three-option picker meaningless — two
  // of its three choices rendered identically on any machine without Inter installed.
  var BLOG_FONTS = [
${fontRows}
  ];

  // ── Assistant icon colours ─────────────────────────────────────────────────
  // The palette a user picks their assistant's icon colour from, and the id-derived colour an
  // assistant that has never been styled falls back to. Generated rather than retyped because the
  // fallback has to agree exactly between the two sides: the server decides what a stored colour
  // normalises to, the browser decides what an unstyled assistant looks like, and any drift between
  // them repaints assistants at random. Consumed by /assistant-colors.js (window.AssistantColors),
  // which is what every surface actually calls.
  window.AssistantColorPalette = {
    /** [{ value, name }] — swatch order is the order the picker renders them in. */
    colors: ${JSON.stringify(ASSISTANT_COLORS)},

    /** The hex values in the same order — the membership test both sides validate against. */
    values: ${JSON.stringify(ASSISTANT_COLOR_VALUES)},

    /** Drawn for rows belonging to no assistant (the "Be More Swan" actor). Never assignable. */
    neutral: ${JSON.stringify(ASSISTANT_COLOR_NEUTRAL)},
  };

  window.BlogFonts = {
    all: BLOG_FONTS,
    categories: ${JSON.stringify(BLOG_FONT_CATEGORIES)},
    defaultStack: ${JSON.stringify(DEFAULT_FONT_STACK)},

    /** Look a font up by its STORED value (the CSS stack). null when it isn't one we offer. */
    get: function (stack) {
      if (typeof stack !== 'string') return null;
      var v = stack.trim();
      for (var i = 0; i < BLOG_FONTS.length; i++) {
        if (BLOG_FONTS[i].stack === v) return BLOG_FONTS[i];
      }
      return null;
    },

    /**
     * The stylesheet a stored stack needs, or null when it needs none.
     * ⚠️ Returns null for an UNKNOWN stack too. That is deliberate: the caller stores what it gets,
     * and inventing a URL for a stack we don't recognise would store one the validator rejects.
     */
    urlFor: function (stack) {
      var f = this.get(stack);
      return (f && f.url) || null;
    },

    /** Fonts in one category, in catalogue order — the picker renders an <optgroup> per category. */
    inCategory: function (category) {
      return BLOG_FONTS.filter(function (f) { return f.category === category; });
    },

    /**
     * Look a font up by its DISPLAY FAMILY NAME rather than its stack — 'Poppins', 'Georgia'.
     * Mirrors matchBlogFontByFamily in src/config/blog-fonts.ts, for the one caller that has a
     * bare family name: the org's brand kit, which records what their own website uses.
     * null for a family we cannot serve, so the caller leaves the font alone instead of guessing.
     */
    matchFamily: function (family) {
      if (typeof family !== 'string') return null;
      var want = family.trim().toLowerCase().replace(/\\s+/g, ' ').replace(/^["']|["']$/g, '');
      if (!want) return null;
      for (var i = 0; i < BLOG_FONTS.length; i++) {
        if (BLOG_FONTS[i].label.toLowerCase() === want) return BLOG_FONTS[i];
      }
      return null;
    },
  };
})();
`;
}

// Only write when run directly, so importing this from a test doesn't touch the working tree.
if (process.argv[1] && process.argv[1].endsWith('gen-client-constants.ts')) {
    mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
    writeFileSync(OUTPUT_PATH, renderClientConstants());
    console.log(`Wrote ${OUTPUT_PATH}`);
}
