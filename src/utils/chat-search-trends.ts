// src/utils/chat-search-trends.ts
// Google Trends for chat (docs/google-trends-plan.md Phase 2): the Blog Writer and the Business Mentor
// see the workspace's tracked search terms — seasons, rising interest, related searches — from the same
// loader as Business Information ▸ What people search and Blog setup (search-trends-read.ts).
// Social Media and Email Marketing joined in Phase 3 (they also get timely angles in scheduled drafts,
// src/utils/trend-angles.ts). The block ends with the instructions for the
// 'search_terms' card (chat-search-terms-card.ts), so either chat can propose a change to the list.
//
// ⚠️ Never throws. Related searches are third-party text: searchTrendsPromptBlock fences them as data.

import type { getDb } from '../../db/client';
import { searchTermsCardInstructions } from './chat-search-terms-card';
import { loadOrgTrends, searchTrendsPromptBlock } from './search-trends-read';

type Db = ReturnType<typeof getDb>;

/** Roles whose chat gets this block. */
export const SEARCH_TREND_ROLES: readonly string[] = ['blog_writer', 'business_mentor', 'social_media_manager', 'newsletter_editor'];

const PURPOSE = 'SEARCH TRENDS for the terms this workspace tracks (Business Information ▸ What people search). Use them when they ask what people search for, '
    + 'when their busy season is, what to write about next, or what to plan ahead of a peak. Suggest content a few weeks BEFORE a peak, not during it.';

const NONE = 'SEARCH TRENDS: this workspace tracks no search terms yet. If they ask about seasons or what people search for, say they can choose terms in '
    + 'Business Information ▸ What people search (or ask you to add some), and that the first data arrives within a day. Never invent trends.';

/** The block for this turn's prompt. Null for other roles; an admission when the read fails. */
export async function buildSearchTrendsBlock(db: Db, organisationId: number, roleKey: string | null | undefined): Promise<string | null> {
    if (!roleKey || !SEARCH_TREND_ROLES.includes(roleKey)) return null;
    try {
        const data = searchTrendsPromptBlock(await loadOrgTrends(db, organisationId), PURPOSE) ?? NONE;
        return `${data}\n${searchTermsCardInstructions()}`;
    } catch (err) {
        console.error('[chat-search-trends] could not read trends (non-fatal)', err);
        return 'SEARCH TRENDS could not be read this turn — say so if asked; never quote a trend from memory.';
    }
}
