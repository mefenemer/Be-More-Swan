// src/config/lead-rating-chips.ts
// How a lead's hot / warm / cold rating is COLOURED, in one place.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// The rating was rendered by three surfaces, each with its own class strings:
//   • the Searches tab's result rows      (assistant-signal-inbox.js ratingChip)
//   • the Leads tab's Rating column       (assistant-data-hub.js rowHtml)
//   • the lead scoring card               (disruptive-ui-registry.js RATING_STYLES)
// and the three did not agree — a "hot" lead was emerald in two of them and neutral grey in the
// third, so the same fact about the same lead looked like a different fact on a different tab.
// That is the identical failure mode the bands themselves had before src/config/icp-profile.ts
// existed, and it is fixed the same way: one definition, mirrored to the browser through
// scripts/gen-client-constants.ts (window.LeadRating.chips).
//
// ⚠️ Keyed by `LeadRating`, so this is EXHAUSTIVE by the type checker. Adding or renaming a band in
// RATING_BANDS fails the build here rather than silently leaving the new band unstyled.
//
// ── Why these colours ────────────────────────────────────────────────────────
// Temperature, read as temperature: orange for hot, yellow for warm, blue for cold. The previous
// emerald/amber/grey ramp read as good/ok/bad — a value judgement on the LEAD, when the rating is
// about fit against the user's own profile, not quality. Cold in particular was styled as the
// "off" state (grey, and grey is what this table uses for "nothing has happened"), which made a
// legitimately-scored lead look like a record with a missing field.
//
// ⚠️ Every class here is ALREADY COMPILED into style.css. The site has no Tailwind build step at
// deploy time, and rebuilding the stylesheet to gain one shade churns unrelated selectors app-wide.
// Check any new class against style.css before adding it — a novel one renders unstyled.
//
// ⚠️ `cold` shares its blue with LEAD_OUTREACH_CHIPS.drafted and with the Leads tab's "Checking…"
// contact chip. They never mean the same thing, and in the Leads table they can sit in the same
// row, three columns apart. Tolerated because each column has a heading and the alternative was
// keeping cold in the grey that made it look unscored — but do not add a fourth blue here.

import type { LeadRating } from './icp-profile';

/**
 * The chip for each band.
 *
 * `label` is the bare word, because that is what the table cell and the result row already show.
 * `cardLabel` is the scoring card's longer form ("Hot lead") — it sits alone at the top of a card
 * with no column heading to say what the word is about.
 * `bar` styles the 0-100 score meter on that same card, so the meter cannot contradict the chip
 * beside it.
 */
export const LEAD_RATING_CHIPS: Record<LeadRating, {
    label: string;
    cardLabel: string;
    cls: string;
    bar: string;
}> = {
    hot: {
        label: 'Hot',
        cardLabel: 'Hot lead',
        cls: 'bg-orange-50 text-orange-800 border-orange-200',
        bar: 'bg-orange-600',
    },
    warm: {
        label: 'Warm',
        cardLabel: 'Warm lead',
        cls: 'bg-yellow-50 text-yellow-700 border-yellow-200',
        bar: 'bg-yellow-500',
    },
    cold: {
        label: 'Cold',
        cardLabel: 'Cold lead',
        cls: 'bg-blue-50 text-blue-800 border-blue-200',
        bar: 'bg-blue-500',
    },
};

/**
 * The chip for an UNKNOWN or absent rating.
 *
 * A CSV-imported lead and a record written before scoring existed both carry no rating, and they
 * must not borrow a band's colour — "cold" is a verdict the scorer reached, not the absence of one.
 * Neutral grey is the same thing the rest of these tables use for "nothing has happened yet".
 *
 * ⚠️ This is also the fallback when the generated mirror has not loaded. It is deliberately NOT a
 * second copy of the three colours above: a surface that cannot read the mirror renders the
 * unstyled-but-honest chip rather than a hand-typed duplicate that will drift.
 */
export const LEAD_RATING_CHIP_UNKNOWN = {
    cls: 'bg-gray-100 text-gray-500 border-gray-200',
    bar: 'bg-gray-400',
};
