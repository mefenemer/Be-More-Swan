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
    POSTING_CADENCES, NUMBER_WORDS, DEFAULT_POSTING_FREQUENCY, postsPerWeekFor, readCadence,
} from '../src/config/posting-cadence';

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
  var postsPerWeekFor = ${postsPerWeekFor.toString()};
  var readCadence = ${readCadence.toString()};

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
