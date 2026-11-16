// src/utils/chat-search-terms-card.ts
// The `search_terms` chat card (docs/google-trends-plan.md Phase 2): the Business Mentor or Blog Writer
// proposes adding, approving or removing a tracked Google search term, or asks Haiku for suggestions;
// the user's click does it. Same contract as the other confirm cards: the model proposes, this module
// checks the proposal against the stored list, and the click (disruptive-ui-registry.js) POSTs to
// search-trends.ts — the very action Business Information ▸ What People Search uses. Nothing here writes.
//
// ⚠️ Never throws.

import type { getDb } from '../../db/client';
import { COUNTRY_LOCATION } from '../lib/trends-provider';
import { MAX_TRACKED_PER_ORG, normaliseTerm } from './search-trends';
import { loadOrgTrends, type OrgTrend } from './search-trends-read';

type Db = ReturnType<typeof getDb>;

export const SEARCH_TERMS_CARD_TYPE = 'search_terms';
export type SearchTermsAction = 'add' | 'approve' | 'approve_all' | 'remove' | 'suggest';

export interface SearchTermsCard {
    type: typeof SEARCH_TERMS_CARD_TYPE;
    action: SearchTermsAction;
    term: string | null;
    termId: number | null;
    region: string | null;
    regionName: string | null;
    count: number | null;
    blocked: string | null;
    settled?: boolean;
}

/** The card's instructions, appended to the search trends block on the routes that offer it. Pure. */
export function searchTermsCardInstructions(): string {
    return `CHANGING THE TRACKED SEARCH TERMS — when the user asks to track, approve or stop tracking a search term, or asks you to suggest some, put this in "uiElement" instead of anything else:
{ "type": "search_terms", "action": "add" | "approve" | "approve_all" | "remove" | "suggest", "term": "boiler service", "region": "GB" }
"term" for add/approve/remove (as listed above for approve/remove; 1–3 broad words customers type for add — never their business name or a town). "region" only for add, one of ${Object.keys(COUNTRY_LOCATION).join(', ')} (leave it out for their own country). Up to ${MAX_TRACKED_PER_ORG} terms. You never change the list yourself: the user confirms on the card, and only that click does it. So never say a term HAS been added or removed — say the card is there to confirm.`;
}

/** Shape check and the card, against the stored list. Pure. Null when it isn't this card. */
export function searchTermsCardFrom(uiElement: unknown, trends: OrgTrend[]): SearchTermsCard | null {
    if (!uiElement || typeof uiElement !== 'object') return null;
    const ui = uiElement as Record<string, unknown>;
    if (ui.type !== SEARCH_TERMS_CARD_TYPE) return null;
    const actions: SearchTermsAction[] = ['add', 'approve', 'approve_all', 'remove', 'suggest'];
    const action = actions.includes(ui.action as SearchTermsAction) ? ui.action as SearchTermsAction : null;
    const card: SearchTermsCard = { type: SEARCH_TERMS_CARD_TYPE, action: action ?? 'add', term: null, termId: null, region: null, regionName: null, count: null, blocked: null };
    if (!action) { card.blocked = 'I can add, approve or remove a search term, or suggest some — nothing else.'; return card; }

    if (action === 'suggest') {
        if (trends.length >= MAX_TRACKED_PER_ORG) card.blocked = `You already track ${MAX_TRACKED_PER_ORG} terms. Remove some first.`;
        return card;
    }
    if (action === 'approve_all') {
        card.count = trends.filter((t) => !t.approved).length;
        if (!card.count) card.blocked = 'No suggested terms are waiting for approval.';
        return card;
    }
    const term = normaliseTerm(ui.term);
    card.term = term;
    if (!term) { card.blocked = 'That search term is empty or too long.'; return card; }
    if (action === 'add') {
        const iso = typeof ui.region === 'string' ? ui.region.trim().toUpperCase() : '';
        const region = COUNTRY_LOCATION[iso === 'UK' ? 'GB' : iso];
        card.region = region ? (iso === 'UK' ? 'GB' : iso) : null;
        card.regionName = region?.name ?? null;
        const same = trends.find((t) => t.term === term && (!region || t.locationName === region.name));
        if (same) card.blocked = same.approved ? `“${term}” is already tracked.` : `“${term}” is already suggested — approve it instead.`;
        else if (trends.length >= MAX_TRACKED_PER_ORG) card.blocked = `You already track ${MAX_TRACKED_PER_ORG} terms. Remove one first.`;
        return card;
    }
    const match = trends.find((t) => t.term === term);
    card.termId = match?.termId ?? null;
    card.regionName = match?.locationName ?? null;
    if (!match) card.blocked = `“${term}” isn’t on your list of search terms.`;
    else if (action === 'approve' && match.approved) card.blocked = `“${term}” is already approved and tracked.`;
    return card;
}

/** The orchestrator's entry: rebuild the proposed card against the live list. */
export async function resolveSearchTermsCard(db: Db, organisationId: number, uiElement: unknown): Promise<SearchTermsCard | null> {
    try {
        return searchTermsCardFrom(uiElement, await loadOrgTrends(db, organisationId));
    } catch (err) {
        console.error('[chat-search-terms-card] could not build the card (non-fatal)', err);
        return null;
    }
}
