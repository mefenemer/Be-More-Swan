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
    {"id":"instagram","label":"Instagram","charLimit":2200,"aspectRatio":"4:5","mediaMandatory":true,"mediaKind":"image","canPublishVideo":true,"defaultPostFormat":"image"},
    {"id":"facebook","label":"Facebook","charLimit":63206,"aspectRatio":"1:1","mediaMandatory":false,"mediaKind":"image","canPublishVideo":true,"defaultPostFormat":"image"},
    {"id":"linkedin","label":"LinkedIn","charLimit":3000,"aspectRatio":"1:1","mediaMandatory":false,"mediaKind":"image","canPublishVideo":true,"defaultPostFormat":"image"},
    {"id":"x","label":"X (Twitter)","charLimit":280,"aspectRatio":"16:9","mediaMandatory":false,"mediaKind":"image","canPublishVideo":true,"defaultPostFormat":"image"},
    {"id":"threads","label":"Threads","charLimit":500,"aspectRatio":"1:1","mediaMandatory":false,"mediaKind":"image","canPublishVideo":true,"defaultPostFormat":"text"},
    {"id":"youtube","label":"YouTube","charLimit":5000,"aspectRatio":"16:9","mediaMandatory":true,"mediaKind":"video","canPublishVideo":true,"defaultPostFormat":"video"},
  ];

  var byId = {};
  for (var i = 0; i < PLATFORMS.length; i++) byId[PLATFORMS[i].id] = PLATFORMS[i];

  window.PlatformConstants = {
    /** Every platform we can draft and publish for, in a stable order. */
    all: PLATFORMS,

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
})();
