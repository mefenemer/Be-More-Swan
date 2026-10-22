// src/utils/chat-library.ts
// The assistant's own reference library — the Support Agent's Knowledge Base and the Social Media /
// Blog Writer assistants' Inspo — as the chat sees it, and a card to add to it.
//
// ── Why ──────────────────────────────────────────────────────────────────────────────────────────
// Every capability is meant to be reachable from the GUI and from chat, through the same server
// action. Both chats USE their library (KB retrieval grounds the Support Agent's answers; the Inspo
// block shapes every draft) but "remember our refund policy" or "learn from this post I love" could
// only be done in the tab, and the chat did not even know what was in it.
//
// ── How ──────────────────────────────────────────────────────────────────────────────────────────
// Same contract as the other confirm cards. The model proposes `kb_article_proposal` {title, content}
// or `inspo_proposal` {kind: text|url, body|url, note}; this module checks it by the endpoint's own
// rules (src/utils/library-rules.ts — the limits, the link check, the per-assistant ceiling) and
// returns a card showing EXACTLY what will be saved. The click (chat-session.js) POSTs to kb-articles.ts
// / inspo-items.ts as the tab's own Save does. Nothing here writes.
//
// The content must be the USER's: an article is facts the user gave, an Inspo item is writing or a
// link the user shared. The prompt says so; the card shows the whole text so the user can see it.
// Editing, deleting and file uploads stay in the tabs.
//
// ⚠️ Never throws.

import { and, desc, eq, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { inspoItems, kbArticles } from '../../db/schema';
import {
    INSPO_MAX_BODY_CHARS, INSPO_MAX_ITEMS, INSPO_MAX_NOTE_CHARS, INSPO_MAX_TITLE_CHARS, KB_MAX_ARTICLES, KB_MAX_CONTENT_CHARS,
    KB_MAX_TITLE_CHARS, deriveInspoTitle, validateInspoUrl,
} from './library-rules';

type Db = ReturnType<typeof getDb>;

export const KB_PROPOSAL_TYPE = 'kb_article_proposal';
export const INSPO_PROPOSAL_TYPE = 'inspo_proposal';

/** Roles whose page has the Knowledge Base tab / the Inspo tab (assistant-dashboard-registry.js
 *  kbTab / inspoTab — pinned by tests/chat-library.test.ts). */
export const KB_ROLES: readonly string[] = ['tier1_support_agent'];
export const INSPO_ROLES: readonly string[] = ['social_media_manager', 'blog_writer'];

/** Titles listed in the prompt; the count is always given in full. */
const LIST_MAX = 30;

const listTitles = (rows: Array<{ title: string }>, total: number) =>
    `${rows.map((r) => `- "${r.title.replace(/\s+/g, ' ').trim()}"`).join('\n')}${total > rows.length ? `\n- …and ${total - rows.length} more` : ''}`;

/** The block for this turn's prompt. Null for a role with neither tab, or when the read fails. */
export async function buildLibraryBlock(db: Db, organisationId: number, aiAssistantId: number, roleKey: string | null | undefined): Promise<string | null> {
    try {
        if (roleKey && KB_ROLES.includes(roleKey)) {
            const scope = and(eq(kbArticles.organisationId, organisationId), eq(kbArticles.aiAssistantId, aiAssistantId));
            const [[c], rows] = await Promise.all([
                db.select({ n: sql<number>`count(*)::int` }).from(kbArticles).where(scope),
                db.select({ title: kbArticles.title }).from(kbArticles).where(scope).orderBy(desc(kbArticles.updatedAt)).limit(LIST_MAX),
            ]);
            const total = Number(c?.n) || 0;
            return `YOUR KNOWLEDGE BASE ("Knowledge Base" tab) — ${total} article${total === 1 ? '' : 's'}${total ? ', most recently changed first:\n' + listTitles(rows, total) : '.'}
ADDING AN ARTICLE — when the user gives you facts about their business to keep (a policy, prices, opening hours, how something works) and wants you to remember them or answer from them, put this in "uiElement" instead of anything else:
{ "type": "${KB_PROPOSAL_TYPE}", "title": "<short title>", "content": "<the article>" }
The content must be ONLY what the user told you in this conversation — tidy the wording into clear sentences, keep every fact they gave, and add none of your own (no invented prices, times, conditions or contact details). If an article with that title is already listed, say so and ask whether they want it changed in the "Knowledge Base" tab instead. Editing or deleting an article, and uploading a file, are done in the "Knowledge Base" tab. You never add it yourself: the user confirms on the card, and only that click saves it — so never say it HAS been added.`;
        }
        if (roleKey && INSPO_ROLES.includes(roleKey)) {
            const scope = and(eq(inspoItems.organisationId, organisationId), eq(inspoItems.aiAssistantId, aiAssistantId));
            const [[c], rows] = await Promise.all([
                db.select({ n: sql<number>`count(*)::int` }).from(inspoItems).where(scope),
                db.select({ title: inspoItems.title }).from(inspoItems).where(scope).orderBy(desc(inspoItems.updatedAt)).limit(LIST_MAX),
            ]);
            const total = Number(c?.n) || 0;
            return `YOUR INSPO ("Inspo" tab) — ${total} item${total === 1 ? '' : 's'} you study and apply to every draft${total ? ', most recently changed first:\n' + listTitles(rows, total) : '.'}
ADDING TO IT — when the user shares writing they admire (pasted text) or a link to it, and wants you to learn from it or write like it, put this in "uiElement" instead of anything else:
{ "type": "${INSPO_PROPOSAL_TYPE}", "kind": "text" | "url", "body": "<for text: exactly what they pasted>", "url": "<for url: the link>", "title": "<optional short title>", "note": "<what they like about it, in their own words, if they said>" }
Use only what the user shared — never write an example yourself and never change the text they pasted. A file, a voice memo, editing or removing an item are done in the "Inspo" tab. You never add it yourself: the user confirms on the card, and only that click saves it — so never say it HAS been added.`;
        }
        return null;
    } catch (err) {
        console.error('[chat-library] could not build the block (non-fatal)', err);
        return null;
    }
}

// ── Propose ──────────────────────────────────────────────────────────────────────────────────────

export type LibraryRequest =
    | { which: 'kb'; title: string; content: string }
    | { which: 'inspo'; kind: 'text' | 'url'; body: string; url: string; title: string; note: string };

/** Shape check. Pure. Null when it is not a library proposal. */
export function libraryProposalFromUiElement(uiElement: unknown): LibraryRequest | null {
    if (!uiElement || typeof uiElement !== 'object') return null;
    const ui = uiElement as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    if (ui.type === KB_PROPOSAL_TYPE) return { which: 'kb', title: str(ui.title), content: str(ui.content) };
    if (ui.type === INSPO_PROPOSAL_TYPE) {
        const kind = ui.kind === 'url' || (!str(ui.body) && str(ui.url)) ? 'url' : 'text';
        return { which: 'inspo', kind, body: str(ui.body), url: str(ui.url), title: str(ui.title), note: str(ui.note) };
    }
    return null;
}

export interface KbCard {
    type: typeof KB_PROPOSAL_TYPE;
    assistantId: number;
    title: string;
    content: string;
    blocked: string | null;
    settled?: boolean;
}

export interface InspoCard {
    type: typeof INSPO_PROPOSAL_TYPE;
    assistantId: number;
    kind: 'text' | 'url';
    title: string;
    /** For text: the note's text. Empty for a link. */
    body: string;
    /** For a link: the checked URL. Empty for text. */
    url: string;
    note: string;
    blocked: string | null;
    settled?: boolean;
}

export type LibraryCard = KbCard | InspoCard;

/** Build the card by the endpoint's rules. Pure — `existing` is how many the assistant already has. */
export function buildLibraryCard(aiAssistantId: number, roleKey: string | null | undefined, req: LibraryRequest, existing: number): LibraryCard {
    if (req.which === 'kb') {
        const card: KbCard = { type: KB_PROPOSAL_TYPE, assistantId: aiAssistantId, title: req.title.slice(0, KB_MAX_TITLE_CHARS), content: req.content, blocked: null };
        if (!roleKey || !KB_ROLES.includes(roleKey)) card.blocked = 'This assistant doesn’t have a Knowledge Base.';
        else if (!card.title) card.blocked = 'An article needs a title.';
        else if (!card.content) card.blocked = 'An article needs some content.';
        else if (card.content.length > KB_MAX_CONTENT_CHARS) card.blocked = `That’s too long for one article (max ${KB_MAX_CONTENT_CHARS.toLocaleString('en-GB')} characters) — split it into smaller articles.`;
        else if (existing >= KB_MAX_ARTICLES) card.blocked = `The Knowledge Base is full (max ${KB_MAX_ARTICLES} articles).`;
        return card;
    }
    const card: InspoCard = {
        type: INSPO_PROPOSAL_TYPE, assistantId: aiAssistantId, kind: req.kind,
        title: '', body: req.kind === 'text' ? req.body : '', url: '', note: req.note.slice(0, INSPO_MAX_NOTE_CHARS), blocked: null,
    };
    if (req.kind === 'url') {
        const checked = validateInspoUrl(req.url);
        if ('error' in checked) card.blocked = checked.error;
        else card.url = checked.url;
    }
    // The endpoint's own title rule, so the card names it as the tab will.
    card.title = (req.title ? req.title.slice(0, INSPO_MAX_TITLE_CHARS)
        : req.kind === 'text' ? (card.body ? deriveInspoTitle(card.body) : '') : (card.url ? new URL(card.url).hostname : ''));
    if (card.blocked) return card;
    if (!roleKey || !INSPO_ROLES.includes(roleKey)) card.blocked = 'This assistant doesn’t have an Inspo library.';
    else if (req.kind === 'text' && !card.body) card.blocked = 'There’s no text to add.';
    else if (card.body.length > INSPO_MAX_BODY_CHARS) card.blocked = `That’s too long (max ${INSPO_MAX_BODY_CHARS.toLocaleString('en-GB')} characters) — split it into separate notes.`;
    else if (existing >= INSPO_MAX_ITEMS) card.blocked = `Your Inspo library is full (max ${INSPO_MAX_ITEMS} items). Delete a few to add more.`;
    return card;
}

async function countExisting(db: Db, organisationId: number, aiAssistantId: number, which: 'kb' | 'inspo'): Promise<number> {
    const [c] = which === 'kb'
        ? await db.select({ n: sql<number>`count(*)::int` }).from(kbArticles).where(and(eq(kbArticles.organisationId, organisationId), eq(kbArticles.aiAssistantId, aiAssistantId)))
        : await db.select({ n: sql<number>`count(*)::int` }).from(inspoItems).where(and(eq(inspoItems.organisationId, organisationId), eq(inspoItems.aiAssistantId, aiAssistantId)));
    return Number(c?.n) || 0;
}

/** Check a proposal and return the card. Null when the read fails. */
export async function resolveLibraryProposal(
    db: Db, organisationId: number, aiAssistantId: number, roleKey: string | null | undefined, req: LibraryRequest,
): Promise<LibraryCard | null> {
    try {
        return buildLibraryCard(aiAssistantId, roleKey, req, await countExisting(db, organisationId, aiAssistantId, req.which));
    } catch (err) {
        console.error('[chat-library] could not resolve the proposal (non-fatal)', err);
        return null;
    }
}

/** A stored card closes once what it would add is already there (same title / same text / same link). */
export async function refreshLibraryCards<M extends { uiElement: unknown }>(
    db: Db, organisationId: number, aiAssistantId: number, messages: M[],
): Promise<M[]> {
    const open = (m: M) => {
        const ui = m.uiElement as Record<string, unknown> | null;
        return ui && (ui.type === KB_PROPOSAL_TYPE || ui.type === INSPO_PROPOSAL_TYPE) && !ui.settled && !ui.blocked ? ui : null;
    };
    if (!messages.some(open)) return messages;
    try {
        const [kb, inspo] = await Promise.all([
            messages.some((m) => open(m)?.type === KB_PROPOSAL_TYPE)
                ? db.select({ title: kbArticles.title }).from(kbArticles).where(and(eq(kbArticles.organisationId, organisationId), eq(kbArticles.aiAssistantId, aiAssistantId)))
                : Promise.resolve([] as Array<{ title: string }>),
            messages.some((m) => open(m)?.type === INSPO_PROPOSAL_TYPE)
                ? db.select({ body: inspoItems.body, sourceUrl: inspoItems.sourceUrl }).from(inspoItems).where(and(eq(inspoItems.organisationId, organisationId), eq(inspoItems.aiAssistantId, aiAssistantId)))
                : Promise.resolve([] as Array<{ body: string | null; sourceUrl: string | null }>),
        ]);
        const titles = new Set(kb.map((r) => r.title.trim().toLowerCase()));
        const bodies = new Set(inspo.map((r) => (r.body ?? '').trim()).filter(Boolean));
        const urls = new Set(inspo.map((r) => r.sourceUrl ?? '').filter(Boolean));
        return messages.map((m) => {
            const ui = open(m);
            if (!ui) return m;
            const done = ui.type === KB_PROPOSAL_TYPE
                ? titles.has(String(ui.title ?? '').trim().toLowerCase())
                : (ui.kind === 'url' ? urls.has(String(ui.url ?? '')) : bodies.has(String(ui.body ?? '').trim()));
            return done ? { ...m, uiElement: { ...ui, settled: true, blocked: 'Already added.' } } : m;
        });
    } catch (err) {
        console.error('[chat-library] could not refresh stored cards (non-fatal)', err);
        return messages;
    }
}
