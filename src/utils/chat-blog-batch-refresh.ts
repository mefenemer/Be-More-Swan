// src/utils/chat-blog-batch-refresh.ts
// A stored "Write all N" card (src/utils/blog-chat-batch.ts) whose articles already exist is shown as
// started, so reopening the conversation does not offer a button that would queue them all again.
// Part of the src/utils/chat-card-refresh.ts chain. Never throws.

import { and, eq, inArray } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { blogPosts } from '../../db/schema';
import { BLOG_BATCH_PROPOSAL_TYPE } from './blog-chat-batch';

type Db = ReturnType<typeof getDb>;

export async function refreshBlogBatchCards<M extends { uiElement: unknown }>(
    db: Db, organisationId: number, aiAssistantId: number, messages: M[],
): Promise<M[]> {
    return Promise.all(messages.map(async (m) => {
        const ui = m.uiElement as Record<string, unknown> | null;
        if (!ui || ui.type !== BLOG_BATCH_PROPOSAL_TYPE || ui.queued || !Array.isArray(ui.topics)) return m;
        const titles = (ui.topics as Array<{ title?: unknown }>).map((t) => String(t?.title ?? '')).filter(Boolean);
        if (!titles.length) return m;
        try {
            const rows = await db.select({ title: blogPosts.title }).from(blogPosts).where(and(
                eq(blogPosts.organisationId, organisationId),
                eq(blogPosts.assistantId, aiAssistantId),
                inArray(blogPosts.title, titles),
            ));
            const have = new Set(rows.map((r) => r.title));
            return titles.every((t) => have.has(t)) ? { ...m, uiElement: { ...ui, queued: true } } : m;
        } catch (err) {
            console.error('[chat-blog-batch-refresh] could not refresh a stored card (non-fatal)', err);
            return m;
        }
    }));
}
