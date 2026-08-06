// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Written by scripts/gen-client-constants.ts from src/config/platform-formats.ts.
// Run `npm run gen:constants` after changing platform facts, and commit the result: the site has no
// build step, so this file IS what the browser loads.
//
// It exists because workspace.html cannot import from src/. Every constant here used to be retyped
// into that page by hand, and every hand copy eventually drifted — dropping platforms from posts,
// or letting through drafts the server would refuse. Read from window.PlatformConstants instead of
// writing another copy.
(function () {
  'use strict';

  var PLATFORMS = [
    {"id":"instagram","label":"Instagram","charLimit":2200,"aspectRatio":"4:5","mediaMandatory":true,"mediaKind":"image","canPublishVideo":true,"linksClickable":false,"defaultPostFormat":"image"},
    {"id":"facebook","label":"Facebook","charLimit":63206,"aspectRatio":"1:1","mediaMandatory":false,"mediaKind":"image","canPublishVideo":true,"linksClickable":true,"defaultPostFormat":"image"},
    {"id":"linkedin","label":"LinkedIn","charLimit":3000,"aspectRatio":"1:1","mediaMandatory":false,"mediaKind":"image","canPublishVideo":true,"linksClickable":true,"defaultPostFormat":"image"},
    {"id":"x","label":"X (Twitter)","charLimit":280,"aspectRatio":"16:9","mediaMandatory":false,"mediaKind":"image","canPublishVideo":true,"linksClickable":true,"defaultPostFormat":"image"},
    {"id":"threads","label":"Threads","charLimit":500,"aspectRatio":"1:1","mediaMandatory":false,"mediaKind":"image","canPublishVideo":true,"linksClickable":true,"defaultPostFormat":"text"},
    {"id":"youtube","label":"YouTube","charLimit":5000,"aspectRatio":"16:9","mediaMandatory":true,"mediaKind":"video","canPublishVideo":true,"linksClickable":true,"defaultPostFormat":"video"},
  ];

  // Every post format, from src/config/post-formats.ts. workspace.html reads this as _PCE_FORMATS.
  var POST_FORMATS = [
    {"k":"ig_feed","p":"instagram","n":"Feed post","d":"A single image in the main feed.","m":"image","ar":"4:5","min":1,"max":1,"cl":2200,"a":"live"},
    {"k":"ig_reel","p":"instagram","n":"Reel","d":"Full-screen vertical video, pushed by the algorithm.","m":"video","ar":"9:16","min":1,"max":1,"cl":2200,"a":"live"},
    {"k":"ig_carousel","p":"instagram","n":"Carousel","d":"Up to 20 swipeable image slides.","m":"mixed","ar":"4:5","min":2,"max":20,"cl":2200,"a":"live"},
    {"k":"ig_story","p":"instagram","n":"Story","d":"Vertical, disappears after 24 hours.","m":"mixed","ar":"9:16","min":1,"max":1,"cl":0,"a":"planned","why":"Stories publish through a different Instagram endpoint we haven’t connected yet."},
    {"k":"ig_broadcast","p":"instagram","n":"Broadcast channel","d":"One-to-many message straight into follower DMs.","m":"none","ar":"","min":0,"max":1,"cl":2200,"a":"blocked","why":"Broadcast channels are direct messaging, not feed posts — they can’t be scheduled as a post."},
    {"k":"ig_live","p":"instagram","n":"Live","d":"Real-time video broadcast.","m":"none","ar":"9:16","min":0,"max":0,"cl":0,"a":"blocked","why":"Going live happens in the moment — there is nothing to draft or schedule here."},
    {"k":"fb_feed","p":"facebook","n":"Feed post","d":"Text, a link, an image or a video.","m":"mixed","ar":"1:1","min":0,"max":1,"cl":63206,"a":"live"},
    {"k":"fb_reel","p":"facebook","n":"Reel","d":"Vertical short-form video, often shared from Instagram.","m":"video","ar":"9:16","min":1,"max":1,"cl":63206,"a":"planned","why":"Facebook Reels use a separate video endpoint from feed posts, which we haven’t connected yet."},
    {"k":"fb_story","p":"facebook","n":"Story","d":"Vertical, disappears after 24 hours.","m":"mixed","ar":"9:16","min":1,"max":1,"cl":0,"a":"planned","why":"Stories publish through a different Facebook endpoint we haven’t connected yet."},
    {"k":"fb_group","p":"facebook","n":"Group post","d":"Posted into a community group feed.","m":"image","ar":"1:1","min":0,"max":1,"cl":63206,"a":"planned","why":"Posting to a group needs group selection and its own permissions, which the Facebook connection doesn’t request yet."},
    {"k":"fb_live","p":"facebook","n":"Live","d":"Real-time video broadcast.","m":"none","ar":"","min":0,"max":0,"cl":0,"a":"blocked","why":"Going live happens in the moment — there is nothing to draft or schedule here."},
    {"k":"th_text","p":"threads","n":"Text post","d":"Short conversational update.","m":"mixed","ar":"1:1","min":0,"max":1,"cl":500,"a":"live"},
    {"k":"th_carousel","p":"threads","n":"Carousel","d":"Up to 20 swipeable items.","m":"mixed","ar":"1:1","min":2,"max":20,"cl":500,"a":"live"},
    {"k":"th_voice","p":"threads","n":"Voice note","d":"A playable audio recording in the feed.","m":"audio","ar":"","min":1,"max":1,"cl":500,"a":"planned","why":"We have no audio recording or upload path yet — the content library only handles images and video."},
    {"k":"th_poll","p":"threads","n":"Poll","d":"Interactive vote with up to four options.","m":"none","ar":"","min":0,"max":0,"cl":500,"a":"planned","why":"Polls need their own options editor and a different API call — not built yet."},
    {"k":"li_feed","p":"linkedin","n":"Feed post","d":"Text, an image, or an outbound link.","m":"image","ar":"1:1","min":0,"max":1,"cl":3000,"a":"live"},
    {"k":"li_video","p":"linkedin","n":"Native video","d":"Video uploaded straight to the feed.","m":"video","ar":"16:9","min":1,"max":1,"cl":3000,"a":"live"},
    {"k":"li_document","p":"linkedin","n":"Document carousel","d":"A PDF that reads as swipeable slides — LinkedIn’s strongest format.","m":"document","ar":"","min":1,"max":1,"cl":3000,"a":"planned","why":"Needs PDF upload and LinkedIn’s document endpoint; the content library doesn’t accept documents yet."},
    {"k":"li_article","p":"linkedin","n":"Article / newsletter","d":"Long-form writing with subscribers.","m":"none","ar":"","min":0,"max":1,"cl":110000,"a":"blocked","why":"Long-form belongs to the Blog Writer, not the social post editor — draft it there and publish to LinkedIn from its destinations."},
    {"k":"li_audio","p":"linkedin","n":"Audio event / Live","d":"Drop-in audio room or live stream.","m":"none","ar":"","min":0,"max":0,"cl":0,"a":"blocked","why":"A live event is not a post — it can’t be drafted and queued like one."},
    {"k":"x_text","p":"x","n":"Post","d":"Short-form text, and the start of a thread.","m":"image","ar":"16:9","min":0,"max":1,"cl":280,"a":"live"},
    {"k":"x_video","p":"x","n":"Native video","d":"Video uploaded straight into the feed.","m":"video","ar":"16:9","min":1,"max":1,"cl":280,"a":"live"},
    {"k":"x_images","p":"x","n":"Image grid","d":"Up to four images in one cropped grid.","m":"image","ar":"16:9","min":2,"max":4,"cl":280,"a":"planned","why":"The grid needs multi-image publishing, which we haven’t built yet."},
    {"k":"x_poll","p":"x","n":"Poll","d":"Interactive vote with up to four options.","m":"none","ar":"","min":0,"max":0,"cl":280,"a":"planned","why":"Polls need their own options editor and a different API call — not built yet."},
    {"k":"x_space","p":"x","n":"Space","d":"Live drop-in audio broadcast.","m":"none","ar":"","min":0,"max":0,"cl":0,"a":"blocked","why":"A Space is a live event, not a post — there is nothing to draft or queue."},
    {"k":"yt_vod","p":"youtube","n":"Video","d":"Standard horizontal video, found through search.","m":"video","ar":"16:9","min":1,"max":1,"cl":5000,"a":"live"},
    {"k":"yt_short","p":"youtube","n":"Short","d":"Vertical short-form video, up to 3 minutes.","m":"video","ar":"9:16","min":1,"max":1,"cl":5000,"maxd":180,"a":"live"},
    {"k":"yt_community","p":"youtube","n":"Community post","d":"Text, image or poll for subscribers between uploads.","m":"image","ar":"1:1","min":0,"max":1,"cl":5000,"a":"planned","why":"The Community tab is a separate YouTube API surface we haven’t connected yet."},
    {"k":"yt_live","p":"youtube","n":"Live","d":"Real-time stream.","m":"none","ar":"","min":0,"max":0,"cl":0,"a":"blocked","why":"Streaming happens in the moment — there is nothing to draft or schedule here."},
  ];

  // scheduled_posts statuses whose schedule is LIVE, from src/config/post-status.ts. A draft's
  // publish_date is only a proposal until someone presses Schedule, so the calendar renders these
  // and nothing else.
  var SCHEDULE_ACTIVE_STATUSES = ["approved","scheduled","publishing","published","paused","paused_credits","failed"];
  var scheduleActive = {};
  for (var s = 0; s < SCHEDULE_ACTIVE_STATUSES.length; s++) scheduleActive[SCHEDULE_ACTIVE_STATUSES[s]] = true;

  // system_connections statuses that mean "reconnect required", from
  // src/config/connection-status.ts. The hand-written copy of this list in integrations.js omitted
  // 'token_expired' — the value the Meta paths write — so a dead Facebook connection rendered as
  // "Connected" until someone noticed posts had stopped going out.
  var DEAD_CONNECTION_STATUSES = ["token_expired","token_refresh_failed","revoked","expired","failed"];
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
  var OUTCOMES = ["won","lost","disqualified"];
  var OUTCOME_LABELS = {"won":"Won","lost":"Lost","disqualified":"Disqualified"};
  var LOSS_REASONS = ["price","timing","no_budget","competitor","no_response","wrong_contact","not_icp","feature_gap","went_silent","other"];
  var LOSS_REASON_LABELS = {"price":"Too expensive","timing":"Bad timing — not now","no_budget":"No budget","competitor":"Went with a competitor","no_response":"Never replied","wrong_contact":"Wrong person — not the decision maker","not_icp":"Not a fit — we should not have targeted them","feature_gap":"We were missing something they needed","went_silent":"Went quiet mid-conversation","other":"Something else"};
  var NEEDS_LOSS_REASON = ["lost","disqualified"];

  // Why a reviewer changed a drafted message (plan §2.6), from src/config/template-feedback.ts.
  // CHECK-constrained server-side, so a drifted copy here would write values the DB rejects.
  var EDIT_REASONS = ["too_formal","too_casual","wrong_value_prop","wrong_pain_point","too_long","factually_wrong","bad_subject","personalisation_missing","other"];
  var EDIT_REASON_LABELS = {"too_formal":"Too formal","too_casual":"Too casual","wrong_value_prop":"Wrong benefit","wrong_pain_point":"Wrong problem","too_long":"Too long","factually_wrong":"Got something wrong","bad_subject":"Weak subject line","personalisation_missing":"Not specific enough","other":"Something else"};

  // Why a reviewer rejected a discovered lead, from src/config/lead-reject-reasons.ts. Also
  // CHECK-constrained server-side.
  var LEAD_REJECT_REASONS = ["competitor","not_a_business","wrong_industry","too_small","too_large","wrong_geography","existing_customer","no_buying_signal","bad_contact","other"];
  var LEAD_REJECT_REASON_LABELS = {"competitor":"Competitor or peer","not_a_business":"Not a real business","wrong_industry":"Wrong industry","too_small":"Too small","too_large":"Too big","wrong_geography":"Wrong location","existing_customer":"Already a customer","no_buying_signal":"No sign they need us","bad_contact":"No usable contact","other":"Something else"};

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
  var POSTING_CADENCES = [{"key":"daily","label":"Daily","postsPerWeek":7},{"key":"5x_week","label":"5 times a week","postsPerWeek":5},{"key":"4x_week","label":"4 times a week","postsPerWeek":4},{"key":"3x_week","label":"3 times a week","postsPerWeek":3},{"key":"2x_week","label":"2 times a week","postsPerWeek":2},{"key":"weekly","label":"Weekly","postsPerWeek":1},{"key":"on_demand","label":"On demand","postsPerWeek":0}];
  var NUMBER_WORDS = {"once":1,"one":1,"twice":2,"two":2,"three":3,"four":4,"five":5,"six":6,"seven":7};
  var DEFAULT_POSTING_FREQUENCY = "3 times a week";
  var postsPerWeekFor = function postsPerWeekFor(value){if(typeof value!=="string")return 0;const raw=value.trim().toLowerCase();if(!raw)return 0;const byKey=POSTING_CADENCES.find(c=>c.key===raw);if(byKey)return byKey.postsPerWeek;const byLabel=POSTING_CADENCES.find(c=>c.label.toLowerCase()===raw);if(byLabel)return byLabel.postsPerWeek;if(/on[\s-]?demand|as needed|ad[\s-]?hoc|manual/.test(raw))return 0;if(/fortnight|every (two|2) weeks|bi[\s-]?weekly/.test(raw))return .5;if(/\bdaily\b|every ?day/.test(raw))return 7;if(/\bweekly\b|every ?week/.test(raw))return 1;const perDay=raw.match(/(\d+)\s*(?:x|times)?\s*(?:per|a|\/)?\s*day/);if(perDay)return Number(perDay[1])*7;const perWeek=raw.match(/(\d+)\s*(?:x|times)?\s*(?:per|a|\/)?\s*week/);if(perWeek)return Number(perWeek[1]);for(const[word,n]of Object.entries(NUMBER_WORDS)){if(new RegExp(`\\b${word}\\b.*\\bday`).test(raw))return n*7;if(new RegExp(`\\b${word}\\b.*\\bweek`).test(raw))return n}const bare=raw.match(/^(\d+)$/);if(bare)return Number(bare[1]);return 0};
  var readCadence = function readCadence(value){const postsPerWeek=postsPerWeekFor(value);if(postsPerWeek>0)return{postsPerWeek,kind:"scheduled"};const raw=String(value??"").trim().toLowerCase();if(!raw)return{postsPerWeek:postsPerWeekFor(DEFAULT_POSTING_FREQUENCY),kind:"scheduled"};const canonical=POSTING_CADENCES.some(c=>c.key===raw||c.label.toLowerCase()===raw);if(canonical)return{postsPerWeek:0,kind:"on_demand"};if(/on[\s-]?demand|as needed|ad[\s-]?hoc|manual/.test(raw))return{postsPerWeek:0,kind:"on_demand"};return{postsPerWeek:0,kind:"unrecognised"}};

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
