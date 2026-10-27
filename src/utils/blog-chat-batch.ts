// src/utils/blog-chat-batch.ts
//
// "Draft all 5" from the Blog Writer chat (owner, 2026-10-27).
//
// A chat reply can carry ONE article (blog_post_draft): the whole body rides inside the reply's
// JSON, so asking for five meant five round trips — and a long reply that truncated produced a
// "done" with no draft, which is how the fifth one was lost. Several articles are therefore NOT
// written in the reply at all. The model proposes a `blog_batch_proposal` — titles and a one-line
// brief each — and the card's one button queues every one through generate-blog.ts, the same
// background worker Blog Studio's "Ask your assistant to draft" uses (process-blog-jobs). Each
// article is written on the worker's own time budget and lands in Review on the Blogs tab.
//
// Kept free of DB/SDK imports so both the orchestrator and the tests can use it.

export const BLOG_BATCH_PROPOSAL_TYPE = 'blog_batch_proposal';

/** The most one card queues. Each is a whole article and a task from the allowance. */
export const MAX_BATCH_ARTICLES = 10;
const MAX_TITLE = 200;
const MAX_BRIEF = 600;

export interface BlogBatchTopic {
    title: string;
    brief: string | null;
}

export interface BlogBatchCard {
    type: typeof BLOG_BATCH_PROPOSAL_TYPE;
    topics: BlogBatchTopic[];
    /** How many the model asked for beyond MAX_BATCH_ARTICLES — said on the card, never silently dropped. */
    more: number;
}

const clean = (v: unknown, max: number): string | null => {
    if (typeof v !== 'string') return null;
    const s = v.replace(/\s+/g, ' ').trim();
    return s ? s.slice(0, max) : null;
};

/** Shape check on the model's output. Null unless it names at least one usable title. */
export function blogBatchFromUiElement(uiElement: unknown): BlogBatchCard | null {
    if (!uiElement || typeof uiElement !== 'object') return null;
    const ui = uiElement as Record<string, unknown>;
    if (ui.type !== BLOG_BATCH_PROPOSAL_TYPE || !Array.isArray(ui.topics)) return null;
    const seen = new Set<string>();
    const all: BlogBatchTopic[] = [];
    for (const t of ui.topics) {
        const o: Record<string, unknown> = (t && typeof t === 'object') ? t as Record<string, unknown> : { title: t };
        const title = clean(o.title, MAX_TITLE);
        if (!title || seen.has(title.toLowerCase())) continue;
        seen.add(title.toLowerCase());
        all.push({ title, brief: clean(o.brief, MAX_BRIEF) });
    }
    if (!all.length) return null;
    return {
        type: BLOG_BATCH_PROPOSAL_TYPE,
        topics: all.slice(0, MAX_BATCH_ARTICLES),
        more: Math.max(0, all.length - MAX_BATCH_ARTICLES),
    };
}
