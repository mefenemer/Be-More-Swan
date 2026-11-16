// src/utils/chat-search-queries.ts
// "Searches that found you" for chat (docs/google-trends-plan.md Phase 1b): the Blog Writer and the
// Business Mentor see the real Google searches that showed the workspace's own site, so "what are
// people searching for?" or "write about what people ask" is answered from the same list as
// Blog setup ▸ Search performance — GUI and chat read one store (src/utils/gsc-queries.ts).
//
// Read-only: no card. Choosing what to write still goes through the normal draft and topic cards.
// ⚠️ Never throws. Queries are third-party text: searchQueriesPromptBlock fences them as data.

import type { getDb } from '../../db/client';
import { loadSearchQueries, searchQueriesPromptBlock } from './gsc-queries';

type Db = ReturnType<typeof getDb>;

/** Roles whose chat gets this block. */
export const SEARCH_QUERY_ROLES: readonly string[] = ['blog_writer', 'business_mentor'];

const NONE = 'SEARCHES THAT FOUND THEM: none stored. Either Google Search Console is not connected (Blog setup on the Blogs tab ▸ Search performance), '
    + 'it was connected less than a day ago, or Google has no searches to report for their site yet. Say which is likely if asked; never invent searches.';

/** The block for this turn's prompt. Null for other roles; an admission when the read fails. */
export async function buildSearchQueriesBlock(db: Db, organisationId: number, roleKey: string | null | undefined): Promise<string | null> {
    if (!roleKey || !SEARCH_QUERY_ROLES.includes(roleKey)) return null;
    try {
        const snap = await loadSearchQueries(db, organisationId, 20);
        const block = searchQueriesPromptBlock(snap,
            'SEARCHES THAT FOUND THEM (Blog setup on the Blogs tab ▸ Search performance). Use these when they ask what people search for, '
            + 'which topics to write about, or why a post gets found. Each count is for their own site only, over the dates shown.', 20);
        return block ?? NONE;
    } catch (err) {
        console.error('[chat-search-queries] could not read searches (non-fatal)', err);
        return 'SEARCHES THAT FOUND THEM could not be read this turn — say so if asked; never quote a search from memory.';
    }
}
