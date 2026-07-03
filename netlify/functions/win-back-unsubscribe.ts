// netlify/functions/win-back-unsubscribe.ts
// US-GAP-4.2.1 SC5: Unsubscribe from win-back email sequence
//
// GET ?token=<base64-encoded userId>
// Inserts a row into win_back_opt_outs and returns a simple confirmation page.
// The token is base64url-encoded "wb-unsub:<userId>" — low-security but sufficient
// for an email unsubscribe link (no auth cookie required by design).

import { Handler } from '@netlify/functions';
import { getDb } from '../../db/client';
import { winBackOptOuts } from '../../db/schema';

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    const token = event.queryStringParameters?.token;
    if (!token) {
        return { statusCode: 400, headers: { 'Content-Type': 'text/html' }, body: '<p>Invalid unsubscribe link.</p>' };
    }

    try {
        const decoded = Buffer.from(token, 'base64url').toString('utf8');
        if (!decoded.startsWith('wb-unsub:')) throw new Error('Invalid token format');

        const userId = parseInt(decoded.replace('wb-unsub:', ''), 10);
        if (isNaN(userId)) throw new Error('Invalid user ID');

        const db = getDb();
        await db.insert(winBackOptOuts)
            .values({ userId })
            .onConflictDoNothing(); // idempotent — clicking twice is fine

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'text/html' },
            body: `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Unsubscribed — Be More Swan</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f9fafb}
.card{background:#fff;border-radius:1rem;padding:2.5rem;max-width:400px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08)}
h1{font-size:1.25rem;margin-bottom:.5rem}p{color:#6b7280;font-size:.9rem}a{color:#2563eb}</style></head>
<body><div class="card">
  <div style="font-size:2rem;margin-bottom:1rem">✅</div>
  <h1>You've been unsubscribed</h1>
  <p>You won't receive any more re-subscription emails from us. Your account is unaffected.</p>
  <p style="margin-top:1.5rem"><a href="${process.env.BASE_URL || ''}/billing.html">Return to billing →</a></p>
</div></body></html>`,
        };
    } catch (err) {
        return { statusCode: 400, headers: { 'Content-Type': 'text/html' }, body: '<p>Invalid or expired unsubscribe link.</p>' };
    }
};
