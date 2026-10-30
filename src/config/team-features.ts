// src/config/team-features.ts
// Newer things each assistant can do, told to the Business Mentor (src/utils/mentor-snapshot.ts) so it
// can suggest them when one fits a goal or a gap. The model knows the roles only by name: a feature
// that isn't listed here, it can't recommend — and would guess at. Pure.
//
// Add a line when a role gains a feature a customer has to choose to use (a new tab, a new kind of
// card). Write it from the code and the Help Centre article, never from the plan: what the user does,
// what it costs, and what it never does. Keyed by master_assistants.role_key.

export interface TeamFeature {
    /** The date it reached every workspace (YYYY-MM-DD). */
    since: string;
    /** As the user sees it on screen. */
    name: string;
    text: string;
}

export const TEAM_FEATURES: Readonly<Record<string, readonly TeamFeature[]>> = {
    lead_qualifier: [{
        since: '2026-10-30',
        name: 'Discussions tab',
        text: 'finds public forum threads from the last week where someone asks for what this business sells, or for advice it can give — on Reddit, UK Business Forums, Quora and LinkedIn posts, plus up to 5 forums of the user\'s own added by web address (a trade forum, or a US community such as Indie Hackers, Shopify Community, BiggerPockets or ContractorTalk). It drafts a helpful reply ending with a disclosure line; the USER posts it from their own account — nothing is ever posted for them. Set up on the Lead Generator\'s Discussions tab (up to 5 topics, written the way a customer would ask) or by asking the Lead Generator in chat. One scan = one task; a daily morning scan is optional. Help Centre: "Finding Forum Threads Worth Replying To".',
    }],
};
