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
  };
})();
