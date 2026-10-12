// netlify/functions/assistant-showcase.ts
// GET ?roleKey=<key> → { showcase } — the long-form public page content for one assistant
// (assistant.html): overview, how it works, features with screenshots, FAQs. Public, no auth: it is
// marketing copy, the same audience as the assistant library.
//
// ⚠️ Never an outage. db/z-assistant-showcases.sql creates the table; on a database it has not
// reached yet the read fails with 42P01, and this answers { showcase: null } so the page falls back
// to the short version (tagline, description, key features) rather than an error.

import { sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { withLambda } from '@netlify/aws-lambda-compat';

const json = (statusCode: number, body: unknown, cache = false) => ({
    statusCode,
    headers: {
        'Content-Type': 'application/json',
        // Copy changes rarely; a few minutes of caching takes the load off the marketing page.
        ...(cache ? { 'Cache-Control': 'public, max-age=300' } : {}),
    },
    body: JSON.stringify(body),
});

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });
    const roleKey = String(event.queryStringParameters?.roleKey || '').trim();
    if (!/^[a-z][a-z0-9_]{1,60}$/.test(roleKey)) return json(400, { error: 'roleKey is required.' });

    try {
        const rows = await getDb().execute<{ content: unknown }>(
            sql`SELECT content FROM assistant_showcases WHERE role_key = ${roleKey} LIMIT 1`);
        const row = (rows as unknown as Array<{ content: unknown }>)[0];
        return json(200, { showcase: row ? row.content : null }, true);
    } catch (err) {
        const code = (err as { code?: string; cause?: { code?: string } })?.code
            ?? (err as { cause?: { code?: string } })?.cause?.code;
        if (code === '42P01') return json(200, { showcase: null });
        console.error('[assistant-showcase] read failed', { roleKey, err });
        return json(200, { showcase: null });
    }
});
