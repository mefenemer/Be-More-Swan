// src/config/icp-profile.ts
// The ideal-customer-profile prompt block, in ONE place.
//
// ⚠️ This existed as three hand copies — src/lib/discovery-scoring.ts (icpBlock), the private
// icpBlock in netlify/functions/lead-generation.ts, and an inline template literal in the
// `lead_qualifier` route of netlify/functions/chat-orchestrator.ts. They had already drifted
// ("treat as neutral" vs "treat industry as neutral"), and SCORING_BANDS was pasted into all three.
// That matters more than tidiness: discovery scores a company with one wording and chat scores the
// same company with another, so the two surfaces can disagree about a lead for no reason the user
// can see.
//
// The snapshot's SHAPE lives in src/utils/icp-snapshot.ts (icpFromOnboarding). This module renders
// it. Keep that split: the shape is an attribution key written to revenue_events, the rendering is
// prompt text, and only one of the two is safe to change without a migration conversation.

/**
 * The bands every scoring surface must agree on.
 *
 * Duplicated in three prompts before this module existed. A lead rated "warm" by discovery and
 * "cold" by chat, because one copy said 40-69 and the other did not, is indistinguishable from a
 * model being inconsistent — and would have been debugged as such.
 */
export const RATING_BANDS = [
    { rating: 'hot', min: 70, max: 100, meaning: 'strong profile fit + buying intent' },
    { rating: 'warm', min: 40, max: 69, meaning: 'partial fit or unclear intent' },
    { rating: 'cold', min: 0, max: 39, meaning: 'poor fit or no intent' },
] as const;

export type LeadRating = (typeof RATING_BANDS)[number]['rating'];

/**
 * ⚠️ BUILT from RATING_BANDS, not typed out beside it. The bands are now also shown to USERS — the
 * hot/warm/cold chip in the Searches results explains itself on hover — and a hand-written tooltip
 * would have been the fourth copy of a number that has already drifted once between prompts. The
 * generated browser mirror (src/generated/platform-constants.js → window.LeadRating) comes from the
 * same array, so the model's rubric and the user's explanation cannot disagree.
 *
 * tests/icp-snapshot.test.ts pins the rendered string, so a change here is visible in review rather
 * than silently re-scoring every lead in the estate.
 */
export const SCORING_BANDS =
    `Scoring bands: ${RATING_BANDS.map((b) => `${b.min}-${b.max} = "${b.rating}" (${b.meaning})`).join(', ')}.`;

/**
 * Render the profile block from an ICP snapshot (or, for chat, the raw onboarding answers — the
 * keys are identical by construction, which is the point of icpFromOnboarding()).
 *
 * Every line degrades to an explicit "not specified" rather than being omitted. An absent line
 * reads to the model as a criterion that does not exist; a stated one reads as a criterion to
 * treat as neutral, and only the second is true.
 */
export function icpBlock(icp: Record<string, unknown>): string {
    const lines = [
        `- Target industries: ${icp.targetIndustries ? JSON.stringify(icp.targetIndustries) : 'not specified — treat industry as neutral'}`,
        `- Minimum company headcount: ${icp.minHeadcount ?? 'not specified — treat company size as neutral'}`,
        `- Sales tone: ${icp.salesTone ?? 'professional'} — write outreach and next steps in this tone.`,
    ];
    // Only rendered when answered. Unlike the lines above, "no exclusions specified" is not a
    // criterion to weigh — it is the absence of one, and spelling it out invites the model to
    // invent exclusions to fill the gap.
    const exclude = icp.excludeProfile;
    if (typeof exclude === 'string' && exclude.trim()) {
        lines.push(`- NOT customers — never target these, however well they match the lines above: ${exclude.trim()}`);
    }
    return lines.join('\n');
}

/**
 * The rule that makes `excludeProfile` bite.
 *
 * ── Why this is separate from the block above ────────────────────────────────
 * The scorer already had an anti-competitor instruction ("a software vendor or agency that SELLS
 * TO the target market"), and it did not work, because the model has no way to know which side of
 * that line the USER is on. With targetIndustries = "creative, professional services, e-commerce",
 * an agency serving those industries is a perfect match on every stated criterion. The profile was
 * three lines about who we want and zero about who we are.
 *
 * So this is stated as a hard verdict rather than a scoring penalty: a peer is not a weak lead to
 * be ranked below a strong one, it is a company that must never be contacted. That is exactly what
 * doNotContact means, and routing it there rather than to the score is what stops a competitor
 * resurfacing the moment a run finds nothing better.
 */
export const EXCLUDE_PROFILE_RULE =
    'When the profile lists companies that are NOT customers, treat a match against that list as decisive: score it 0-10, rate it "cold", and say plainly in reasons which exclusion it matched. This outranks every other signal — a competitor with strong buying intent is still a competitor. Being in a target industry is NOT evidence against this: peers and competitors are usually in the same industry as the customers they serve, which is why the exclusion list exists.';

/**
 * The `doNotContact` half of the rule, for the surfaces whose card shape actually carries the flag.
 *
 * ⚠️ NOT appended on the chat route: `lead_qualifier` in chat-orchestrator.ts declares a
 * lead_scoring_card with no `doNotContact` key, so telling the model to set one there asks it to
 * violate the schema it was just given — and a model resolving that conflict does something
 * unpredictable to the whole object, not just to the extra field. Add it there only together with
 * the field itself.
 */
export const EXCLUDE_PROFILE_DNC_RULE =
    'A match against the exclusion list also means "doNotContact": true — emailing a competitor is not a weak send, it is a wrong one. Set outreachDraft to null when it is true.';

// ── The prospect-type gate ───────────────────────────────────────────────────
//
// WHAT a candidate is, asked and answered before HOW WELL it fits. The two questions had been
// merged into one score, and a score is the wrong instrument for the first one: fit is a
// judgement on a spectrum, "is this even a company we could sell to" is a yes/no that outranks
// every point of fit above it.
//
// ⚠️ The prod run of 2026-08-12 is why this is now a FIELD and not a paragraph. The scorer had
// been told, in prose, to reject "a software vendor or agency that SELLS TO the target market",
// and it still rated treyd.io (embedded finance for e-commerce sellers) 75/hot and
// idsfulfillment.com (a B2B 3PL) 72/hot. Two independent failures:
//
//  1. The ENUMERATION was too narrow to recognise them. Neither a lender nor a fulfilment
//     warehouse is "a software vendor or agency", so a model matching the instruction literally
//     had nothing to match. Suppliers to a market are not mostly SaaS companies.
//  2. The instruction was UNENFORCEABLE. It asked for a score, and the same pass that scored
//     also decided whether the rule applied — so a model that noticed the conflict could simply
//     not apply it, and nothing downstream could tell that it had. Sixty-four leads later, the
//     only evidence was two hot cards that read perfectly well.
//
// So the model now emits its classification as data, and normaliseLeadCard() clamps on it in
// code (see DISQUALIFIED_MAX_SCORE). The model still makes the judgement — it is the only thing
// here that can read a snippet — but it no longer gets to both make it and ignore it.

/**
 * What the candidate IS. Closed vocabulary: the model must pick one, and code acts on the answer.
 *
 * `target_business` is the ONLY value that can carry a real score. Everything else is a page or a
 * company that no amount of profile fit can turn into a customer.
 */
export const PROSPECT_TYPES = [
    'target_business',      // a business of the type the profile describes — could buy from us
    'supplier_to_target',   // sells TO that market: vendor, agency, 3PL, lender, wholesaler…
    'aggregator',           // directory, marketplace, curated collection, data platform
    'media',                // news outlet, magazine, publisher, podcast
    'content_page',         // an article, guide, listicle, PDF or template — not a company
    'platform',             // social network, forum, wiki, job board
] as const;

export type ProspectType = (typeof PROSPECT_TYPES)[number];

/**
 * The ceiling a disqualified candidate's score is clamped to.
 *
 * Not zero, deliberately. Zero is also what a failed parse and an empty card produce, so a
 * disqualified lead scored 0 is indistinguishable in the Leads tab from one the scorer never
 * managed to look at. 10 is unambiguously cold, and unambiguously a verdict.
 */
export const DISQUALIFIED_MAX_SCORE = 10;

/** True for every prospect type that cannot be a customer, whatever the profile fit. */
export function isDisqualifyingProspectType(value: unknown): value is ProspectType {
    return typeof value === 'string'
        && (PROSPECT_TYPES as readonly string[]).includes(value)
        && value !== 'target_business';
}

/**
 * The prompt half of the gate. Pair it with the "prospectType" key in the surface's JSON schema —
 * asking for the reasoning without asking for the field gets you the old prose rule back.
 *
 * ⚠️ Scoped to DISCOVERED candidates. Do not add this to the manual `score_lead` path in
 * lead-generation.ts: there the user typed the company in themselves, so "is this a real prospect"
 * has already been answered by a human, and a model overruling them would be a bug, not a filter.
 */
export const PROSPECT_TYPE_RULE =
`FIRST, before scoring, decide what each candidate IS and return it as "prospectType". This is a gate, not a criterion: only "target_business" can score above ${DISQUALIFIED_MAX_SCORE}.
- "target_business" — a business of the kind the profile describes. It would BUY what we sell.
- "supplier_to_target" — a business whose own CUSTOMERS are that kind. Software and SaaS, agencies, consultancies and studios, logistics, 3PL, warehousing, fulfilment, freight, couriers and packaging, payments, lending, financing, invoice factoring, insurance and accounting, wholesalers, distributors and dropship suppliers, recruiters, trainers and law firms — any of them, not only software.
- "aggregator" — a site that INDEXES businesses of the target type instead of being one: a directory, marketplace, listing or review site, and equally a curated collection, membership network, trade association, tourism or destination board, or a B2B data platform hosting company profile pages.
- "media" — a news outlet, magazine, publisher, podcast or trade title covering the sector.
- "content_page" — an article, blog post, guide, listicle, PDF or template ABOUT the market.
- "platform" — a social network, forum, wiki or job board.

The decisive test for the first two: if the businesses in the profile drew up a list of their SUPPLIERS, would this company be on it? If yes it is "supplier_to_target", however exactly its industry, size and language match the profile — suppliers describe the market they sell into in the same words their customers use about themselves, which is precisely why this keeps scoring hot.

The decisive test for "aggregator": how many businesses of the target type does this site present? ONE — itself — makes it a target_business. MANY makes it an aggregator, however curated, exclusive, editorial or single-brand it looks. "Healing Hotels of the World" and "Design Hotels" read like one hospitality brand and are collections of other people's hotels; a regional tourism board reads like a destination and lists hundreds of venues. Ask who actually fulfils: does this operator deliver the service itself, or hand you on to a member?

⚠️ A PROFILE PAGE is not the company it names. A title shaped "<Some Company> - <Site Name>", where the site is a database, directory, listing or review platform, describes a THIRD PARTY — classify the DOMAIN you were given, not the company in the title. This does NOT apply to an organisation's page about its own branch, sub-brand or subsidiary: "Unity Hospital | Rochester Regional Health" is an operator describing a hospital it runs, and is a target_business.

The strongest single signal is who the copy addresses as "you". "Funding for e-commerce brands", "we help DTC founders scale", "trusted by 500+ retailers" — a company naming the target type as its customers is describing its BUYERS, not itself.

Topical relevance is NOT fit. "An article listing the best wedding venues" is not a wedding venue; "software for managing hotels" is not a hotel; "fulfilment for online stores" is not an online store. When the type is not "target_business", score it 0-${DISQUALIFIED_MAX_SCORE}, rate it "cold", and say plainly in reasons which type it is and why.`;
