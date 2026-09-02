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
  var CAMPAIGN_STATUS_LABELS = {"draft":"Draft","active":"Running","throttled":"Throttled","paused":"Paused","finished":"Finished","archived":"Archived"};
  var CAMPAIGN_ORDER_STATUS_LABELS = {"queued":"Queued","issued":"With the assistant","in_review":"In your review","delivered":"Delivered","blocked":"Blocked","cancelled":"Cancelled","rejected":"Rejected"};
  var CAMPAIGN_DECISION_LABELS = {"strategy":"Strategy","reallocation":"Reallocation","escalation":"Escalation","halt":"Halt"};
  var CAMPAIGN_OUTCOME_LABELS = {"leads":"New leads found","replies":"Replies from prospects","signups":"Signups captured","published_content":"Pieces published"};
  var CAMPAIGN_REJECT_REASONS = ["wrong_channel","too_expensive","bad_timing","evidence_unconvincing","off_brand","doing_it_myself","other"];
  var CAMPAIGN_REJECT_REASON_LABELS = {"wrong_channel":"Wrong channel","too_expensive":"Too much work for the return","bad_timing":"Bad timing","evidence_unconvincing":"I disagree with the evidence","off_brand":"Off brand","doing_it_myself":"I’m doing this myself","other":"Something else"};
  var UNAVAILABLE_OUTCOME_METRICS = ["signups"];
  var CAMPAIGN_LINK_MEDIUMS = ["organic","paid","email","social","other"];
  var PAUSE_REASON_LABELS = {"creative_fatigue":"Click-through rate fell well below its own average","cost_per_outcome":"Each result was costing more than the ceiling you set","budget_exhausted":"The campaign reached its spending limit","human":"You paused it","control_lost":"We lost the connection to the ad account and stopped it as a precaution"};
  // Only the fields the browser renders. artefactKind/assignedRole stay server-side — the client
  // has no business routing an order, and shipping the routing table would invite it to try.
  var ORDER_ACTIONS = [{"key":"draft_social_posts","label":"Draft social posts","description":"Queues extra posts for the Social Media Assistant to draft, on this campaign’s message. They land in its Posts queue for your approval like any other draft."},{"key":"draft_blog_pillar","label":"Write a pillar article","description":"Briefs the Blog Writing Assistant to write one long-form article for this campaign, carrying its keywords and call to action."},{"key":"run_lead_search","label":"Run a lead search","description":"Creates a saved search for the Lead Generation Assistant aimed at this campaign’s audience. Created as a draft — starting it is a separate, human click, because a run costs money and reaches real strangers."},{"key":"narrow_targeting","label":"Narrow the targeting","description":"Edits an existing saved search — tightens the ideal-customer description and adds negative keywords — so it stops finding the wrong kind of company."},{"key":"adjust_messaging","label":"Adjust the messaging","description":"Changes the angle this campaign asks for. Applies to work drafted from now on; it does not rewrite drafts that already exist."}];

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
  var POSTING_CADENCES = [{"key":"daily","label":"Daily","postsPerWeek":7},{"key":"5x_week","label":"5 times a week","postsPerWeek":5},{"key":"4x_week","label":"4 times a week","postsPerWeek":4},{"key":"3x_week","label":"3 times a week","postsPerWeek":3},{"key":"2x_week","label":"2 times a week","postsPerWeek":2},{"key":"weekly","label":"Weekly","postsPerWeek":1},{"key":"on_demand","label":"On demand","postsPerWeek":0}];
  var NUMBER_WORDS = {"once":1,"one":1,"twice":2,"two":2,"three":3,"four":4,"five":5,"six":6,"seven":7};
  var DEFAULT_POSTING_FREQUENCY = "3 times a week";
  var MONDAY_FIRST = ["mon","tue","wed","thu","fri","sat","sun"];
  var DEFAULT_POSTING_DAYS = ["mon","tue","wed","thu","fri"];
  var DEFAULT_POSTING_TIMES = ["09:00"];
  var postsPerWeekFor = function postsPerWeekFor(value){if(typeof value!=="string")return 0;const raw=value.trim().toLowerCase();if(!raw)return 0;const byKey=POSTING_CADENCES.find(c=>c.key===raw);if(byKey)return byKey.postsPerWeek;const byLabel=POSTING_CADENCES.find(c=>c.label.toLowerCase()===raw);if(byLabel)return byLabel.postsPerWeek;if(/on[\s-]?demand|as needed|ad[\s-]?hoc|manual/.test(raw))return 0;if(/fortnight|every (two|2) weeks|bi[\s-]?weekly/.test(raw))return .5;if(/\bdaily\b|every ?day/.test(raw))return 7;if(/\bweekly\b|every ?week/.test(raw))return 1;const perMonth=raw.match(/(\d+)\s*(?:x|times)?\s*(?:per|a|\/)\s*month/);if(perMonth)return Number(perMonth[1])*12/52;if(/\bmonthly\b|every ?month/.test(raw))return 12/52;const perDay=raw.match(/(\d+)\s*(?:x|times)?\s*(?:per|a|\/)?\s*day/);if(perDay)return Number(perDay[1])*7;const perWeek=raw.match(/(\d+)\s*(?:x|times)?\s*(?:per|a|\/)?\s*week/);if(perWeek)return Number(perWeek[1]);for(const[word,n]of Object.entries(NUMBER_WORDS)){if(new RegExp(`\\b${word}\\b.*\\bday`).test(raw))return n*7;if(new RegExp(`\\b${word}\\b.*\\bweek`).test(raw))return n;if(new RegExp(`\\b${word}\\b.*\\bmonth`).test(raw))return n*12/52}const bare=raw.match(/^(\d+)$/);if(bare)return Number(bare[1]);return 0};
  var readCadence = function readCadence(value){const postsPerWeek=postsPerWeekFor(value);if(postsPerWeek>0)return{postsPerWeek,kind:"scheduled"};const raw=String(value??"").trim().toLowerCase();if(!raw)return{postsPerWeek:postsPerWeekFor(DEFAULT_POSTING_FREQUENCY),kind:"scheduled"};const canonical=POSTING_CADENCES.some(c=>c.key===raw||c.label.toLowerCase()===raw);if(canonical)return{postsPerWeek:0,kind:"on_demand"};if(/on[\s-]?demand|as needed|ad[\s-]?hoc|manual/.test(raw))return{postsPerWeek:0,kind:"on_demand"};return{postsPerWeek:0,kind:"unrecognised"}};
  var selectWeeklySlots = function selectWeeklySlots(days,times,perWeek){if(perWeek<=0)return[];const dayset=new Set(days.length?days:DEFAULT_POSTING_DAYS);const ordered=MONDAY_FIRST.filter(d=>dayset.has(d));const timeList=(times.length?times:DEFAULT_POSTING_TIMES).slice().sort();if(!ordered.length||!timeList.length)return[];const grid=[];for(const day of ordered)for(const time of timeList)grid.push({day,time});const count=Math.max(1,Math.min(grid.length,Math.round(perWeek)));if(count>=grid.length)return grid;const picked=[];for(let i=0;i<count;i++){picked.push(grid[Math.floor((i+.5)*grid.length/count)])}return picked};

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
  var LEAD_RECIPIENT_PATHS = [["outreachDraft","to"],["contactEmail"],["lead","email"]];
  var resolveLeadRecipient = function resolveLeadRecipient(data){if(!data||typeof data!=="object")return null;for(const path of LEAD_RECIPIENT_PATHS){let value=data;for(const key of path){if(!value||typeof value!=="object"){value=null;break}value=value[key]}if(typeof value==="string"&&value.trim())return value.trim()}return null};
  var hasOutreachDraft = function hasOutreachDraft(data){if(!data||typeof data!=="object")return false;const draft=data.outreachDraft;if(!draft||typeof draft!=="object")return false;const body=draft.body;return typeof body==="string"&&body.trim().length>0};
  var isLeadDeliverable = function isLeadDeliverable(data){return resolveLeadRecipient(data)!==null&&hasOutreachDraft(data)};

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
  var leadOutreachStage = function leadOutreachStage(data){if(!data||typeof data!=="object"||Array.isArray(data))return null;const raw=data.outreachStage;if(typeof raw!=="string")return null;const v=raw.trim();return v==="review"||v==="triage"?v:null};
  var isInOutreachReview = function isInOutreachReview(data){const stage=leadOutreachStage(data);if(stage==="review")return true;if(stage==="triage")return false;return isLeadDeliverable(data)};

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
  var LEAD_RETENTION_DAYS = 30;
  var RETENTION_FIELD = "retention";
  var RETENTION_DELETED_FIELD = "deletedAt";
  var RETENTION_REASONS = ["do_not_contact","deleted_by_user","rejected","enrichment_failed","not_contactable","unreviewed"];
  var isRetentionDeleted = function isRetentionDeleted(data){if(!data||typeof data!=="object")return false;const r=data[RETENTION_FIELD];if(!r||typeof r!=="object")return false;const at=r[RETENTION_DELETED_FIELD];return typeof at==="string"&&at.trim()!==""};
  var retentionReasonOf = function retentionReasonOf(data){if(!isRetentionDeleted(data))return null;const r=data[RETENTION_FIELD];const reason=r.reason;return typeof reason==="string"&&RETENTION_REASONS.includes(reason)?reason:"unreviewed"};
  var retentionClockStart = function retentionClockStart(updatedAtIso){return updatedAtIso&&updatedAtIso.trim()?updatedAtIso:null};
  var retentionDaysRemaining = function retentionDaysRemaining(clockStartIso,now){if(!clockStartIso)return null;const started=Date.parse(clockStartIso);if(Number.isNaN(started))return null;const deadline=started+LEAD_RETENTION_DAYS*864e5;const remainingMs=deadline-(now?now.getTime():Date.now());if(remainingMs<=0)return 0;return Math.ceil(remainingMs/864e5)};
  var retentionCountdownLabel = function retentionCountdownLabel(daysRemaining){if(daysRemaining===null)return"";if(daysRemaining===0)return"Due for deletion";if(daysRemaining===1)return"1 day left";return`${daysRemaining} days left`};
  var retentionUrgency = function retentionUrgency(daysRemaining){if(daysRemaining===null)return"none";if(daysRemaining<=3)return"urgent";if(daysRemaining<=7)return"soon";return"low"};

  window.LeadRetention = {
    /** How long a lead may sit in Outreach ▸ Review or ▸ Archived before it is moved to Deleted. */
    DAYS: LEAD_RETENTION_DAYS,

    /** Has the sweep already moved this lead? Presence of deletedAt is the test. */
    isDeleted: isRetentionDeleted,

    /** Why it was moved — a RETENTION_REASONS key — or null if the lead is still live. */
    reasonOf: retentionReasonOf,

    /** What the Deleted section prints for each reason. */
    REASON_LABELS: {"do_not_contact":"Must not be contacted","deleted_by_user":"You deleted this lead","rejected":"You turned this lead down","enrichment_failed":"No contact address could be found","not_contactable":"Never had a contact address","unreviewed":"Waited 30 days without a decision"},
    REASON_NOTES: {"do_not_contact":"This company was flagged as one we must never email — a competitor, an internal account, or someone who asked not to be contacted. Sending it back for enrichment will not clear that flag.","deleted_by_user":"You deleted this lead from your list. It is kept here, marked rejected, so a later search that finds the same company again leaves it rejected instead of putting it back in front of you. Sending it back for enrichment returns it to the pipeline.","rejected":"You rejected this lead, and 30 days passed without it being picked back up. Sending it back for enrichment returns it to the pipeline and starts the clock again.","enrichment_failed":"We read this company’s website and found no address to write to. Sending it back for enrichment tries again, including the paid lookup if it is available.","not_contactable":"This lead never had a contact address and was never enriched — cold leads are skipped on rating. Sending it back for enrichment reads their site for the first time.","unreviewed":"A drafted email sat waiting for your approval for 30 days. Nothing was ever sent. Sending it back for enrichment refreshes what we know and returns it to the pipeline."},

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
    NOTICE: "Leads left here for 30 days are moved to Deleted automatically. Nothing is sent, and the move cannot be undone — but the lead is kept, with the reason it was dropped, in the Deleted section of the Enrichment tab. To stop the countdown on a lead, send it back for enrichment before it runs out.",

    /** The Deleted section's own header line. */
    DELETED_NOTICE: "Leads you deleted, plus leads that sat in Outreach for 30 days without a decision or that were rejected and never picked back up. They are kept so a later search does not surface the same company as though it were new. Sending one back for enrichment returns it to the pipeline.",
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
  var ROLE_EMAIL_PREFIXES = new Set(["info","hello","hi","contact","contactus","enquiries","enquiry","inquiries","sales","admin","office","team","mail","general","reception","bookings","support","help","ask","talk","connect","business","reservations","reservation","booking","events","event","enquires","frontdesk","stay","guestservices","concierge","hire","orders","shop","studio","welcome"]);
  var roleOrPersonal = function roleOrPersonal(localPart){const prefix=localPart.trim().toLowerCase();const bare=prefix.replace(/[._-]/g,"");return ROLE_EMAIL_PREFIXES.has(prefix)||ROLE_EMAIL_PREFIXES.has(bare)?"role":"personal"};
  var classifyEmailKind = function classifyEmailKind(email){const value=String(email??"").trim().toLowerCase();if(!value||(value.match(/@/g)||[]).length!==1)return null;const[local,domain]=value.split("@");if(!local||!domain||!domain.includes("."))return null;return roleOrPersonal(local)};

  // Provenance vocabulary + the confirmation gate. Mirrored for the same reason as the classifier
  // above: the Review Queue prints the origin and shows the warning, while the SERVER decides
  // whether the send is allowed. A browser copy that forked would show a reassuring line beside a
  // button the server then refuses — or, far worse, stay quiet about an address it will happily
  // send to a named individual whose details were bought.
  var EMAIL_SOURCE_LABELS = {"scrape":"found on their website","provider":"from a paid data provider","manual":""};
  var emailSourceLabel = function emailSourceLabel(source){return EMAIL_SOURCE_LABELS[String(source??"")]??""};
  var needsPersonalInboxConfirmation = function needsPersonalInboxConfirmation(kind,source){return kind==="personal"&&source!=="manual"&&!!source};

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
  var LEAD_OUTREACH_CHIPS = {"sent":{"label":"Email Sent","cls":"bg-green-50 text-green-700 border-green-100"},"drafted":{"label":"Email Drafted","cls":"bg-blue-50 text-blue-800 border-blue-200"}};
  var leadOutreachState = function leadOutreachState(data){if(!data||typeof data!=="object"||Array.isArray(data))return null;const d=data;if(typeof d.outreachSentAt==="string"&&d.outreachSentAt.trim())return"sent";if(typeof d.outreachDraftedAt==="string"&&d.outreachDraftedAt.trim())return"drafted";return null};

  window.LeadOutreach = {
    /** { sent: { label, cls }, drafted: { label, cls } } — the words and colours every surface uses. */
    chips: LEAD_OUTREACH_CHIPS,

    /** 'sent' | 'drafted' | null for a lead's `data`. Null means nothing has happened to it yet. */
    state: leadOutreachState,

    /** The chip for a lead's `data`, or null. Saves every caller repeating the lookup. */
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
  var RATING_BANDS = [{"rating":"hot","min":70,"max":100,"meaning":"strong profile fit + buying intent"},{"rating":"warm","min":40,"max":69,"meaning":"partial fit or unclear intent"},{"rating":"cold","min":0,"max":39,"meaning":"poor fit or no intent"}];

  // The chip COLOURS, from src/config/lead-rating-chips.ts. Three surfaces draw this chip — the
  // Searches result row, the Leads tab's Rating column and the lead scoring card — and before this
  // was shared they disagreed, so the same lead's rating looked like a different fact per tab.
  var RATING_CHIPS = {"hot":{"label":"Hot","cardLabel":"Hot lead","cls":"bg-orange-50 text-orange-800 border-orange-200","bar":"bg-orange-600"},"warm":{"label":"Warm","cardLabel":"Warm lead","cls":"bg-yellow-50 text-yellow-700 border-yellow-200","bar":"bg-yellow-500"},"cold":{"label":"Cold","cardLabel":"Cold lead","cls":"bg-blue-50 text-blue-800 border-blue-200","bar":"bg-blue-500"}};
  var RATING_CHIP_UNKNOWN = {"cls":"bg-gray-100 text-gray-500 border-gray-200","bar":"bg-gray-400"};

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
    {"label":"System default","stack":"system-ui, sans-serif","category":"System","url":null},
    {"label":"Georgia","stack":"Georgia, serif","category":"System","url":null},
    {"label":"Helvetica / Arial","stack":"Helvetica, Arial, sans-serif","category":"System","url":null},
    {"label":"Times New Roman","stack":"\"Times New Roman\", Times, serif","category":"System","url":null},
    {"label":"Inter","stack":"'Inter', sans-serif","category":"Sans serif","url":"https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap"},
    {"label":"Roboto","stack":"'Roboto', sans-serif","category":"Sans serif","url":"https://fonts.googleapis.com/css2?family=Roboto:wght@400;700&display=swap"},
    {"label":"Open Sans","stack":"'Open Sans', sans-serif","category":"Sans serif","url":"https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;700&display=swap"},
    {"label":"Lato","stack":"'Lato', sans-serif","category":"Sans serif","url":"https://fonts.googleapis.com/css2?family=Lato:wght@400;700&display=swap"},
    {"label":"Montserrat","stack":"'Montserrat', sans-serif","category":"Sans serif","url":"https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700&display=swap"},
    {"label":"Poppins","stack":"'Poppins', sans-serif","category":"Sans serif","url":"https://fonts.googleapis.com/css2?family=Poppins:wght@400;700&display=swap"},
    {"label":"Raleway","stack":"'Raleway', sans-serif","category":"Sans serif","url":"https://fonts.googleapis.com/css2?family=Raleway:wght@400;700&display=swap"},
    {"label":"Nunito","stack":"'Nunito', sans-serif","category":"Sans serif","url":"https://fonts.googleapis.com/css2?family=Nunito:wght@400;700&display=swap"},
    {"label":"Nunito Sans","stack":"'Nunito Sans', sans-serif","category":"Sans serif","url":"https://fonts.googleapis.com/css2?family=Nunito+Sans:wght@400;700&display=swap"},
    {"label":"Work Sans","stack":"'Work Sans', sans-serif","category":"Sans serif","url":"https://fonts.googleapis.com/css2?family=Work+Sans:wght@400;700&display=swap"},
    {"label":"Rubik","stack":"'Rubik', sans-serif","category":"Sans serif","url":"https://fonts.googleapis.com/css2?family=Rubik:wght@400;700&display=swap"},
    {"label":"Manrope","stack":"'Manrope', sans-serif","category":"Sans serif","url":"https://fonts.googleapis.com/css2?family=Manrope:wght@400;700&display=swap"},
    {"label":"DM Sans","stack":"'DM Sans', sans-serif","category":"Sans serif","url":"https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;700&display=swap"},
    {"label":"Karla","stack":"'Karla', sans-serif","category":"Sans serif","url":"https://fonts.googleapis.com/css2?family=Karla:wght@400;700&display=swap"},
    {"label":"Mulish","stack":"'Mulish', sans-serif","category":"Sans serif","url":"https://fonts.googleapis.com/css2?family=Mulish:wght@400;700&display=swap"},
    {"label":"Figtree","stack":"'Figtree', sans-serif","category":"Sans serif","url":"https://fonts.googleapis.com/css2?family=Figtree:wght@400;700&display=swap"},
    {"label":"Outfit","stack":"'Outfit', sans-serif","category":"Sans serif","url":"https://fonts.googleapis.com/css2?family=Outfit:wght@400;700&display=swap"},
    {"label":"Barlow","stack":"'Barlow', sans-serif","category":"Sans serif","url":"https://fonts.googleapis.com/css2?family=Barlow:wght@400;700&display=swap"},
    {"label":"Source Sans 3","stack":"'Source Sans 3', sans-serif","category":"Sans serif","url":"https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;700&display=swap"},
    {"label":"Plus Jakarta Sans","stack":"'Plus Jakarta Sans', sans-serif","category":"Sans serif","url":"https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;700&display=swap"},
    {"label":"Quicksand","stack":"'Quicksand', sans-serif","category":"Sans serif","url":"https://fonts.googleapis.com/css2?family=Quicksand:wght@400;700&display=swap"},
    {"label":"Archivo","stack":"'Archivo', sans-serif","category":"Sans serif","url":"https://fonts.googleapis.com/css2?family=Archivo:wght@400;700&display=swap"},
    {"label":"Public Sans","stack":"'Public Sans', sans-serif","category":"Sans serif","url":"https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;700&display=swap"},
    {"label":"Space Grotesk","stack":"'Space Grotesk', sans-serif","category":"Sans serif","url":"https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;700&display=swap"},
    {"label":"Oswald","stack":"'Oswald', sans-serif","category":"Sans serif","url":"https://fonts.googleapis.com/css2?family=Oswald:wght@400;700&display=swap"},
    {"label":"Merriweather","stack":"'Merriweather', serif","category":"Serif","url":"https://fonts.googleapis.com/css2?family=Merriweather:wght@400;700&display=swap"},
    {"label":"Playfair Display","stack":"'Playfair Display', serif","category":"Serif","url":"https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&display=swap"},
    {"label":"Lora","stack":"'Lora', serif","category":"Serif","url":"https://fonts.googleapis.com/css2?family=Lora:wght@400;700&display=swap"},
    {"label":"PT Serif","stack":"'PT Serif', serif","category":"Serif","url":"https://fonts.googleapis.com/css2?family=PT+Serif:wght@400;700&display=swap"},
    {"label":"Source Serif 4","stack":"'Source Serif 4', serif","category":"Serif","url":"https://fonts.googleapis.com/css2?family=Source+Serif+4:wght@400;700&display=swap"},
    {"label":"Libre Baskerville","stack":"'Libre Baskerville', serif","category":"Serif","url":"https://fonts.googleapis.com/css2?family=Libre+Baskerville:wght@400;700&display=swap"},
    {"label":"Crimson Text","stack":"'Crimson Text', serif","category":"Serif","url":"https://fonts.googleapis.com/css2?family=Crimson+Text:wght@400;700&display=swap"},
    {"label":"EB Garamond","stack":"'EB Garamond', serif","category":"Serif","url":"https://fonts.googleapis.com/css2?family=EB+Garamond:wght@400;700&display=swap"},
    {"label":"Bitter","stack":"'Bitter', serif","category":"Serif","url":"https://fonts.googleapis.com/css2?family=Bitter:wght@400;700&display=swap"},
    {"label":"Cormorant Garamond","stack":"'Cormorant Garamond', serif","category":"Serif","url":"https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;700&display=swap"},
    {"label":"Noto Serif","stack":"'Noto Serif', serif","category":"Serif","url":"https://fonts.googleapis.com/css2?family=Noto+Serif:wght@400;700&display=swap"},
    {"label":"Zilla Slab","stack":"'Zilla Slab', serif","category":"Serif","url":"https://fonts.googleapis.com/css2?family=Zilla+Slab:wght@400;700&display=swap"},
    {"label":"Domine","stack":"'Domine', serif","category":"Serif","url":"https://fonts.googleapis.com/css2?family=Domine:wght@400;700&display=swap"},
    {"label":"Arvo","stack":"'Arvo', serif","category":"Serif","url":"https://fonts.googleapis.com/css2?family=Arvo:wght@400;700&display=swap"},
    {"label":"Spectral","stack":"'Spectral', serif","category":"Serif","url":"https://fonts.googleapis.com/css2?family=Spectral:wght@400;700&display=swap"},
    {"label":"Bebas Neue","stack":"'Bebas Neue', sans-serif","category":"Display","url":"https://fonts.googleapis.com/css2?family=Bebas+Neue:wght@400&display=swap"},
    {"label":"Abril Fatface","stack":"'Abril Fatface', serif","category":"Display","url":"https://fonts.googleapis.com/css2?family=Abril+Fatface:wght@400&display=swap"},
    {"label":"Lobster","stack":"'Lobster', cursive","category":"Display","url":"https://fonts.googleapis.com/css2?family=Lobster:wght@400&display=swap"},
    {"label":"Comfortaa","stack":"'Comfortaa', sans-serif","category":"Display","url":"https://fonts.googleapis.com/css2?family=Comfortaa:wght@400;700&display=swap"},
    {"label":"JetBrains Mono","stack":"'JetBrains Mono', monospace","category":"Monospace","url":"https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap"},
    {"label":"Roboto Mono","stack":"'Roboto Mono', monospace","category":"Monospace","url":"https://fonts.googleapis.com/css2?family=Roboto+Mono:wght@400;700&display=swap"},
    {"label":"IBM Plex Mono","stack":"'IBM Plex Mono', monospace","category":"Monospace","url":"https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;700&display=swap"},
    {"label":"Source Code Pro","stack":"'Source Code Pro', monospace","category":"Monospace","url":"https://fonts.googleapis.com/css2?family=Source+Code+Pro:wght@400;700&display=swap"},
    {"label":"Space Mono","stack":"'Space Mono', monospace","category":"Monospace","url":"https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&display=swap"},
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
    colors: [{"value":"#6366f1","name":"Indigo"},{"value":"#10b981","name":"Green"},{"value":"#f59e0b","name":"Amber"},{"value":"#ec4899","name":"Pink"},{"value":"#06b6d4","name":"Cyan"},{"value":"#8b5cf6","name":"Violet"},{"value":"#ef4444","name":"Red"},{"value":"#14b8a6","name":"Teal"},{"value":"#f97316","name":"Orange"},{"value":"#3b82f6","name":"Blue"}],

    /** The hex values in the same order — the membership test both sides validate against. */
    values: ["#6366f1","#10b981","#f59e0b","#ec4899","#06b6d4","#8b5cf6","#ef4444","#14b8a6","#f97316","#3b82f6"],

    /** Drawn for rows belonging to no assistant (the "Be More Swan" actor). Never assignable. */
    neutral: "#9ca3af",
  };

  window.BlogFonts = {
    all: BLOG_FONTS,
    categories: ["System","Sans serif","Serif","Display","Monospace"],
    defaultStack: "system-ui, sans-serif",

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
      var want = family.trim().toLowerCase().replace(/\s+/g, ' ').replace(/^["']|["']$/g, '');
      if (!want) return null;
      for (var i = 0; i < BLOG_FONTS.length; i++) {
        if (BLOG_FONTS[i].label.toLowerCase() === want) return BLOG_FONTS[i];
      }
      return null;
    },
  };
})();
