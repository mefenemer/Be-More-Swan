// netlify/functions/showcase-media.ts
// GET ?key=showcase/<roleKey>/<file> → 302 to a short-lived signed R2 link.
//
// Serves the screenshots an admin uploads for an assistant's public page (Admin ▸ Assistants ▸
// Website page → admin-assistants.ts ?action=upload-image). The bucket is private, so the page links
// here and this signs. Public — these images are on a public marketing page — but ONLY keys under
// showcase/ and of the exact shape the upload writes, so it can never be used to fetch a tenant's file.

import { presignR2Get } from '../../src/utils/social-publish';
import { SHOWCASE_KEY_RE } from '../../src/utils/assistant-showcase';
import { withLambda } from '@netlify/aws-lambda-compat';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };
    const key = String(event.queryStringParameters?.key || '');
    if (!SHOWCASE_KEY_RE.test(key)) return { statusCode: 404, body: 'Not found' };
    try {
        // Signed for an hour; the redirect itself is cached for five minutes so a busy page does
        // not sign on every view, and always well inside the signature's life.
        const url = await presignR2Get(key, 3600, { stableWindowSec: 600 });
        return { statusCode: 302, headers: { Location: url, 'Cache-Control': 'public, max-age=300' }, body: '' };
    } catch (err) {
        console.error('[showcase-media] could not sign', { key, err });
        return { statusCode: 404, body: 'Not found' };
    }
});
