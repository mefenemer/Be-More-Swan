// src/utils/help-knowledge.ts
// The Help Centre's published articles as one block of model context, so "Ask Your Team"
// (assistant-command.ts) answers "how do I…" from what the product really does — the articles
// in help_articles — instead of from the model's guess (2026-10-20).
//
// The block is byte-stable between article edits (fixed order, no timestamps), which is what lets
// the caller mark it for prompt caching: the articles are read once per cache window, and every
// question after that pays a fraction of their tokens. Plan prices are filled from master data
// exactly as get-help-articles does, so the bar never quotes a price the page does not.

import { asc, eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { helpArticles } from '../../db/schema';
import { planPriceVars, fillPlanPriceTokens } from './plan-price-tokens';

type Db = ReturnType<typeof getDb>;

export interface HelpKnowledge {
    /** Every published article, in Help Centre order, as `<article>` blocks. Empty when none. */
    text: string;
    /** Exact titles, for validating the article the model says it answered from. */
    titles: string[];
}

/** Far above today's Help Centre (~25 articles); past it the oldest-sorted tail is dropped, never mid-article. */
const MAX_CHARS = 300_000;
const TTL_MS = 5 * 60 * 1000; // matches get-help-articles' public cache, so an edit shows up as fast there as here

let cache: { at: number; value: HelpKnowledge } | null = null;

const attr = (s: string) => s.replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' }[c]!));

export function buildHelpKnowledge(rows: Array<{ title: string; category: string | null; contentMd: string | null }>): HelpKnowledge {
    const parts: string[] = [];
    const titles: string[] = [];
    let size = 0;
    for (const r of rows) {
        const block = `<article title="${attr(r.title)}" category="${attr(r.category || 'General')}">\n${(r.contentMd || '').trim()}\n</article>`;
        if (size + block.length > MAX_CHARS) {
            console.warn(`[help-knowledge] Help Centre exceeds ${MAX_CHARS} chars — ${rows.length - titles.length} article(s) left out of Ask Your Team`);
            break;
        }
        parts.push(block);
        titles.push(r.title);
        size += block.length;
    }
    return { text: parts.join('\n\n'), titles };
}

/** Published articles, cached per function instance. A failed read returns an empty knowledge base. */
export async function loadHelpKnowledge(db: Db): Promise<HelpKnowledge> {
    if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
    try {
        const rows = await db
            .select({ title: helpArticles.title, category: helpArticles.category, sortOrder: helpArticles.sortOrder, contentMd: helpArticles.contentMd })
            .from(helpArticles)
            .where(eq(helpArticles.isPublished, true))
            .orderBy(asc(helpArticles.category), asc(helpArticles.sortOrder), asc(helpArticles.title));
        const prices = await planPriceVars(db);
        const value = buildHelpKnowledge(rows.map((r) => ({ ...r, contentMd: fillPlanPriceTokens(r.contentMd ?? '', prices) })));
        cache = { at: Date.now(), value };
        return value;
    } catch (err) {
        console.error('[help-knowledge] could not load help articles:', err);
        return cache?.value ?? { text: '', titles: [] };
    }
}
