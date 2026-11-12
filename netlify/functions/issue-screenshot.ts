// netlify/functions/issue-screenshot.ts — one issue's screenshot, for the AI fix workflow.
//
//   GET /api/issue-screenshot?id=<issueId>&exp=<unix seconds>&t=<HMAC>  → the image bytes
//
// Unauthenticated because the caller is a GitHub Actions run with no session. The signed, two-hour
// link (src/utils/issue-screenshot-link.ts) is what limits it to one issue's screenshot. Minted only
// when an admin passes that issue to the developer.
//
// ⚠️ A function response is capped at 6 MB including base64, so a screenshot over about 4.4 MB
// answers 413 and the workflow carries on without it (Claude is told it isn't available).

import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { issueReports } from '../../db/schema';
import { verifyScreenshotToken, parseScreenshotDataUrl } from '../../src/utils/issue-screenshot-link';
import { withLambda } from '@netlify/aws-lambda-compat';

const MAX_B64 = 5_800_000;
const text = (statusCode: number, body: string) => ({ statusCode, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }, body });

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') return text(405, 'Method Not Allowed');
    const q = event.queryStringParameters || {};
    const id = Number(q.id);
    const exp = Number(q.exp);
    if (!verifyScreenshotToken(id, exp, String(q.t || ''))) return text(403, 'This screenshot link is invalid or has expired.');

    try {
        const [row] = await getDb().select({ data: issueReports.imageData })
            .from(issueReports).where(eq(issueReports.id, id)).limit(1);
        const img = parseScreenshotDataUrl(row?.data);
        if (!img) return text(404, 'No screenshot.');
        if (img.b64.length > MAX_B64) return text(413, 'The screenshot is too large to send.');
        return {
            statusCode: 200,
            headers: { 'Content-Type': img.mime, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
            body: img.b64,
            isBase64Encoded: true,
        };
    } catch (err) {
        console.error('[issue-screenshot] lookup failed for issue', id, err);
        return text(500, 'Could not load the screenshot.');
    }
});
