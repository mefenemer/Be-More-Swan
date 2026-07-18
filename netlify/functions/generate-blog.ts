// netlify/functions/generate-blog.ts
// Autonomous Content Engine — US 1.1: draft a full blog post in the assistant's voice.
//
// This is the INTERACTIVE entry point: it authenticates the caller, then delegates to the shared
// core in src/utils/blog-generate.ts. Blog Autopilot's worker (process-blog-jobs.ts) calls that
// same core without a session, so the two paths cannot drift in voice, grounding or Inspo handling.
//
// POST { blogPostId, topic?, keywords?, notes?, tone? }  →  { bodyMarkdown, tone }

import { HandlerEvent } from '@netlify/functions';
import { getDb } from '../../db/client';
import { requireTenant } from '../../src/utils/tenant';
import { isGlobalAiDisabled } from '../../src/utils/platform-config';
import { generateBlogBody, BlogPostNotFoundError } from '../../src/utils/blog-generate';
import { withLambda } from '@netlify/aws-lambda-compat';

export default withLambda(async (event: HandlerEvent) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    if (await isGlobalAiDisabled()) {
        return { statusCode: 503, body: JSON.stringify({ error: 'AI services are temporarily unavailable. Please try again later.' }) };
    }

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;

    let body: any;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body.' }) }; }

    const id = Number(body.blogPostId);
    if (!Number.isFinite(id)) return { statusCode: 400, body: JSON.stringify({ error: 'blogPostId is required.' }) };

    try {
        const result = await generateBlogBody(db, {
            blogPostId: id,
            organisationId: ctx.organisationId,
            userId: ctx.userId,
            topic: body.topic,
            keywords: body.keywords,
            notes: body.notes,
            tone: body.tone,
        });
        return { statusCode: 200, body: JSON.stringify(result) };
    } catch (error) {
        if (error instanceof BlogPostNotFoundError) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Blog post not found.' }) };
        }
        console.error('[generate-blog] error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Could not generate the draft. Please try again.' }) };
    }
});
