/**
 * src/public/content-pillars.js
 *
 * ONE way to turn what someone typed into "Content Pillars" into a list of pillars. Plain .js, UMD,
 * like brand-contrast.js: the profile (assistants.js — chips + warnings) and the post writer
 * (netlify/functions/process-content-jobs.ts — which pillar a slot gets) must split identically,
 * or the chips show five pillars while the drafts use one.
 *
 * Why (2026-10-06): the two copies split only on commas, semicolons and new lines. Be More Swan's own
 * five pillars were separated by "·" and were treated as ONE pillar (73 posts tagged with the whole
 * string), and a customer's four pillars separated by spaces likewise — so the AI picked whichever
 * theme it liked from the blob, and one pillar ("Food") never appeared.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.ContentPillars = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var MAX_PILLARS = 5;
    /** Longer than this is a sentence, not a theme. */
    var MAX_PILLAR_CHARS = 60;
    // Commas, semicolons, new lines, and the list characters people actually paste: · • | and a
    // spaced slash. Not a bare hyphen — "Restorative practice - conferencing" is one pillar.
    var SPLIT = /[,;\n\r·•|]|\s\/\s/;

    function allParts(raw) {
        var seen = {};
        return (Array.isArray(raw) ? raw.join('\n') : String(raw == null ? '' : raw))
            .split(SPLIT)
            .map(function (p) { return p.replace(/\s+/g, ' ').trim(); })
            .filter(function (p) {
                if (!p) return false;
                var k = p.toLowerCase();
                if (seen[k]) return false;
                seen[k] = true;
                return true;
            });
    }

    /** The pillars, at most five, de-duplicated (case-insensitive), in the order typed. */
    function parsePillars(raw) { return allParts(raw).slice(0, MAX_PILLARS); }

    /** Plain-English problems with what was typed, for the profile to show under the chips. */
    function pillarWarnings(raw) {
        var all = allParts(raw);
        var out = [];
        if (all.length > MAX_PILLARS) out.push('Only the first ' + MAX_PILLARS + ' pillars are used — you have ' + all.length + '.');
        var long = all.slice(0, MAX_PILLARS).filter(function (p) { return p.length > MAX_PILLAR_CHARS; });
        if (long.length) {
            out.push(long.length === 1 && all.length === 1
                ? 'This reads as one long pillar, so your assistant treats it as a single theme. Put each pillar on its own line or separate them with commas.'
                : 'A pillar should be a short theme (a few words). ' + long.length + ' of yours ' + (long.length === 1 ? 'reads' : 'read') + ' like a sentence — shorten ' + (long.length === 1 ? 'it' : 'them') + ' so your assistant can rotate between them.');
        }
        return out;
    }

    return { parsePillars: parsePillars, pillarWarnings: pillarWarnings, MAX_PILLARS: MAX_PILLARS, MAX_PILLAR_CHARS: MAX_PILLAR_CHARS };
}));
