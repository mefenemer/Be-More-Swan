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

  var byId = {};
  for (var i = 0; i < PLATFORMS.length; i++) byId[PLATFORMS[i].id] = PLATFORMS[i];

  window.PlatformConstants = {
    /** Every platform we can draft and publish for, in a stable order. */
    all: PLATFORMS,

    /** Every post format, in catalogue order. Shape matches the editor's _PCE_FORMATS records. */
    formats: POST_FORMATS,

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
`;
}

// Only write when run directly, so importing this from a test doesn't touch the working tree.
if (process.argv[1] && process.argv[1].endsWith('gen-client-constants.ts')) {
    mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
    writeFileSync(OUTPUT_PATH, renderClientConstants());
    console.log(`Wrote ${OUTPUT_PATH}`);
}
