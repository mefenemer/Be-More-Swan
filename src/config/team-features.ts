// src/config/team-features.ts
// Newer things each assistant can do, told to the Business Mentor (src/utils/mentor-snapshot.ts) so it
// can suggest them when one fits a goal or a gap. The model knows the roles only by name: a feature
// that isn't listed here, it can't recommend — and would guess at. Pure.
//
// Add a line when a role gains a feature a customer has to choose to use (a new tab, a new kind of
// card). Write it from the code and the Help Centre article, never from the plan: what the user does,
// what it costs, and what it never does. Keyed by master_assistants.role_key.

import { DISCUSSIONS_ENABLED } from './discussion-sites';

export interface TeamFeature {
    /** The date it reached every workspace (YYYY-MM-DD). */
    since: string;
    /** As the user sees it on screen. */
    name: string;
    text: string;
}

export const TEAM_FEATURES: Readonly<Record<string, readonly TeamFeature[]>> = {
    // Discussions is paused (src/config/discussion-sites.ts DISCUSSIONS_ENABLED) — not offered to the Mentor.
    ...(DISCUSSIONS_ENABLED ? { lead_qualifier: [{
        since: '2026-10-30',
        name: 'Discussions tab',
        text: 'finds public forum threads from the last week where someone asks for what this business sells, or for advice it can give — on Reddit, UK Business Forums, Quora and LinkedIn posts, plus up to 5 forums of the user\'s own added by web address (a trade forum, or a US community such as Indie Hackers, Shopify Community, BiggerPockets or ContractorTalk). It drafts a helpful reply ending with a disclosure line; the USER posts it from their own account — nothing is ever posted for them. Set up on the Lead Generator\'s Discussions tab (up to 5 topics, written the way a customer would ask) or by asking the Lead Generator in chat. One scan = one task; a daily morning scan is optional. Help Centre: "Finding Forum Threads Worth Replying To".',
    }] } : {}),
    // docs/brand-designer-flyers-plan.md. Ships with the flyers code (b4a4a38b), so the Mentor only
    // reads this where flyers exist.
    brand_designer: [{
        since: '2026-11-02',
        name: 'Printable flyers',
        text: 'makes one- or two-sided printable flyers (A5, A4, A6 postcard or DL leaflet) in the brand colours with the logo: "New flyer" on the Brand Designer\'s Briefs tab, or ask the Brand Designer in chat. It drafts the words (1 task) from Business Information and Products & Services — contact details and the offer only from what the business recorded, never invented — then draws up to three pages (free; an AI photo is 1 task). Approving one saves a print-ready PDF to My Content with Print, a home-printing PDF and a print-shop PDF with 3 mm bleed. It never prints, posts or sends a flyer to a print shop for them. Help Centre: "Making a Printed Flyer".',
    }],
};
