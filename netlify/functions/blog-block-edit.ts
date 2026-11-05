// netlify/functions/blog-block-edit.ts — "Use this" on the chat's blog_block_edit card, when the article
// is NOT open in the Blog Studio (when it is, the studio applies it in its editor). One block replaced
// (src/utils/blog-block-edit.ts); the rest of the article is untouched.
//
//   POST { id, find, replace } → { ok: true } | 4xx { error }
//
// Tenant-scoped. A live article is refused, as the chat's "revise" is: its words change on the blog the
// moment they are saved, so that change is made where the author can see it — in the Blog Studio.

import { and, eq } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { blogPosts } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { replaceBlock } from '../../src/utils/blog-block-edit';

const json = (statusCode: number, body: unknown) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    let b: { id?: unknown; find?: unknown; replace?: unknown } = {};
    try { b = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }
    const id = Number(b.id);
    const find = typeof b.find === 'string' ? b.find.slice(0, 6000) : '';
    const replace = typeof b.replace === 'string' ? b.replace.slice(0, 6000) : '';
    if (!Number.isInteger(id) || !find.trim() || !replace.trim()) return json(400, { error: 'Which part, and what to put instead?' });
    const [post] = await db.select({ body: blogPosts.bodyMarkdown, status: blogPosts.status }).from(blogPosts)
        .where(and(eq(blogPosts.id, id), eq(blogPosts.organisationId, ctx.organisationId))).limit(1);
    if (!post) return json(404, { error: 'That article isn\'t in your workspace.' });
    if (post.status === 'published' || post.status === 'publishing') return json(409, { error: 'That article is live on your blog — open it in Blog Studio to change it there.' });
    const next = replaceBlock(post.body, find, replace);
    if (next === null) return json(409, { error: 'That part has changed since — open the article, select it again and ask once more.' });
    await db.update(blogPosts).set({ bodyMarkdown: next, updatedAt: new Date() })
        .where(and(eq(blogPosts.id, id), eq(blogPosts.organisationId, ctx.organisationId)));
    return json(200, { ok: true });
});
