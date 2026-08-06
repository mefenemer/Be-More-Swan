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
export const SCORING_BANDS =
    'Scoring bands: 70-100 = "hot" (strong profile fit + buying intent), 40-69 = "warm" (partial fit or unclear intent), 0-39 = "cold" (poor fit or no intent).';

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
