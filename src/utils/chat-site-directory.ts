// src/utils/chat-site-directory.ts
// The site page directory in the chat: what it last read and which pages are left out, and the
// `site_directory` card that re-reads the site or leaves a page out / puts it back.
// docs/site-directory-plan.md §7.
//
// The pages themselves reach every route through THE loader (site-directory-store.ts
// loadSiteDirectoryBlock); this block only adds what the card needs, on the structured routes.
// Same contract as the other confirm cards: the model proposes, this module checks the proposal
// against the stored directory, and the click (disruptive-ui-registry.js) POSTs to
// site-directory.ts — the very action Business Information ▸ Website Pages uses. Nothing here writes.
//
// ⚠️ Never throws.

import type { getDb } from '../../db/client';
import { cleanDirectoryPath } from './site-directory';
import { directoryView, loadDirectoryRow, type DirectoryView } from './site-directory-store';

type Db = ReturnType<typeof getDb>;

export const SITE_DIRECTORY_CARD_TYPE = 'site_directory';

export interface SiteDirectoryCard {
    type: typeof SITE_DIRECTORY_CARD_TYPE;
    action: 'refresh' | 'exclude' | 'include';
    path: string | null;
    pageTitle: string | null;
    sourceUrl: string | null;
    blocked: string | null;
    settled?: boolean;
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' }) : 'never');

/** The status line and the card's instructions, for this turn's prompt. Pure. */
export function siteDirectoryChatBlock(view: DirectoryView): string {
    const status = view.status === 'none'
        ? 'Your website has not been read yet.'
        : !view.refreshedAt && view.status === 'failed'
            ? `We tried to read ${view.sourceUrl ?? 'the website'} but couldn't${view.message ? `: ${view.message}` : '.'} So no pages are known yet.`
        : `Read from ${view.sourceUrl ?? 'the website'} (${view.source === 'hosted' ? 'the published Be More Swan site' : 'their own website'}), last read ${when(view.refreshedAt)}${view.status === 'reading' ? ' — being read again right now' : ''}${view.status === 'failed' && view.message ? ` — the last attempt failed: ${view.message}` : ''}.`;
    const left = view.pages.filter((p) => p.excluded);
    return `WEBSITE PAGES — Business Information ▸ Website Pages. ${status}
${left.length ? `Left out by the owner (assistants never see these): ${left.map((p) => `${p.path} (${p.title})`).join(', ')}.` : 'No page is left out.'}
The list of pages above (YOUR WEBSITE'S PAGES) is what every assistant reads; it refreshes by itself every week.
CHANGING IT — when the user asks to re-read their site, or to leave a page out of (or put a page back into) what the assistants use, put this in "uiElement" instead of anything else:
{ "type": "site_directory", "action": "refresh" | "exclude" | "include", "path": "/about" }
"path" only for exclude/include, the page's address as listed. Prices are never read from the website — Products & Services is the place for them. You never re-read the site or change the list yourself: the user confirms on the card, and only that click does it. So never say the site HAS been re-read or a page HAS been left out — say the card is there to confirm.`;
}

/** For the chat: load and render. Null on any failure. */
export async function buildSiteDirectoryChatBlock(db: Db, organisationId: number): Promise<string | null> {
    try {
        return siteDirectoryChatBlock(directoryView(await loadDirectoryRow(db, organisationId)));
    } catch (err) {
        console.error('[chat-site-directory] could not build the block (non-fatal)', err);
        return null;
    }
}

/** Shape check and the card, against the stored directory. Pure. Null when it isn't this card. */
export function siteDirectoryCardFrom(uiElement: unknown, view: DirectoryView): SiteDirectoryCard | null {
    if (!uiElement || typeof uiElement !== 'object') return null;
    const ui = uiElement as Record<string, unknown>;
    if (ui.type !== SITE_DIRECTORY_CARD_TYPE) return null;
    const action = ui.action === 'exclude' || ui.action === 'include' ? ui.action : ui.action === 'refresh' ? 'refresh' : null;
    const card: SiteDirectoryCard = { type: SITE_DIRECTORY_CARD_TYPE, action: action ?? 'refresh', path: null, pageTitle: null, sourceUrl: view.sourceUrl, blocked: null };
    if (!action) { card.blocked = 'I can re-read your site, or leave a page out or put it back — nothing else.'; return card; }
    if (action === 'refresh') {
        if (view.status === 'reading') card.blocked = 'Your website is being read right now — it takes a minute or two.';
        else if (view.canRefreshAt) card.blocked = `Your site was read in the last hour. You can re-read it again after ${new Date(view.canRefreshAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' })}.`;
        return card;
    }
    const path = cleanDirectoryPath(ui.path);
    const page = path ? view.pages.find((p) => p.path === path) : undefined;
    card.path = path;
    card.pageTitle = page?.title ?? null;
    if (view.status === 'none') card.blocked = 'Your website hasn’t been read yet — re-read it first.';
    else if (!page) card.blocked = `“${String(ui.path ?? '').slice(0, 80)}” isn’t one of the pages read from your website.`;
    else if (action === 'exclude' && page.excluded) card.blocked = `${page.title} is already left out.`;
    else if (action === 'include' && !page.excluded) card.blocked = `${page.title} isn’t left out — the assistants already use it.`;
    return card;
}

/** The orchestrator's entry: rebuild the proposed card against the live directory. */
export async function resolveSiteDirectoryCard(db: Db, organisationId: number, uiElement: unknown): Promise<SiteDirectoryCard | null> {
    try {
        return siteDirectoryCardFrom(uiElement, directoryView(await loadDirectoryRow(db, organisationId)));
    } catch (err) {
        console.error('[chat-site-directory] could not build the card (non-fatal)', err);
        return null;
    }
}
