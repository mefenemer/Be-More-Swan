// netlify/functions/blog-keywords.ts
// The blog's keywords, workspace-wide (src/utils/blog-keywords.ts). Blog setup's "Keywords" list and
// the chat's keyword card both call this, so the two can't drift.
//
// GET                                   → { keywords: [{ keyword, articles, published }] }
// POST { action: 'rename', from, to }   → { ok, articles, keywords }   (renaming onto an existing one merges)
// POST { action: 'remove', keyword }    → { ok, articles, keywords }
//
// One article's keywords are changed through save-blog-draft { tags }, like its other fields.

import { HandlerEvent } from '@netlify/functions';
import { getDb } from '../../db/client';
import { requireTenant } from '../../src/utils/tenant';
import { listBlogKeywords, removeBlogKeyword, renameBlogKeyword } from '../../src/utils/blog-keywords';
import { withLambda } from '@netlify/aws-lambda-compat';

const json = (statusCode: number, body: unknown) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export default withLambda(async (event: HandlerEvent) => {
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;

    if (event.httpMethod === 'GET') {
        return json(200, { keywords: await listBlogKeywords(db, ctx.organisationId) });
    }
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

    let body: any;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Invalid JSON body.' }); }

    const result = body.action === 'rename'
        ? await renameBlogKeyword(db, ctx.organisationId, body.from, body.to)
        : body.action === 'remove'
            ? await removeBlogKeyword(db, ctx.organisationId, body.keyword)
            : { ok: false as const, error: 'Unknown action.' };
    if (!result.ok) return json(400, { error: result.error });
    return json(200, { ok: true, articles: result.articles, keywords: await listBlogKeywords(db, ctx.organisationId) });
});
