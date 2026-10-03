// netlify/functions/product-update-unsubscribe.ts
// Leaving the weekly "What's new" email.
//
//   HEAD                       → 200, changes nothing (link scanners pre-fetch)
//   GET  ?u=<userId>&s=<sig>   → a page with one "Unsubscribe" button. It does NOT unsubscribe:
//                                corporate link scanners open every link in an email, and a GET
//                                that acted would quietly unsubscribe whole companies.
//   POST ?u=<userId>&s=<sig>   → sets user_profiles.email_preferences.whats_new = false. This is
//                                also the RFC 8058 one-click POST Gmail and Yahoo fire from their own
//                                "Unsubscribe" button (List-Unsubscribe-Post), so it needs no session.
//
// ⚠️ FOUR unsubscribe routes now exist and they are not interchangeable — see the list at the top of
// newsletter-unsubscribe.ts. This one is Be More Swan's OWN feature email to its own CUSTOMERS, and
// it only ever touches the `whats_new` key: account, billing and security emails are unaffected.

import { eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { userProfiles } from '../../db/schema';
import { verifyUnsubscribeSignature } from '../../src/utils/product-update-email';
import { withLambda } from '@netlify/aws-lambda-compat';

const page = (statusCode: number, heading: string, bodyHtml: string, icon: string) => ({
    statusCode,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    body: `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${heading} — Be More Swan</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#fdfcf9;padding:16px;box-sizing:border-box}
.card{background:#fff;border:1px solid #eae4d7;border-radius:1rem;padding:2.5rem;max-width:440px;text-align:center}
h1{font-size:1.25rem;margin:0 0 .5rem;color:#1f1e1b}p{color:#5c564b;font-size:.95rem;line-height:1.6;margin:.5rem 0}
button{cursor:pointer;background:#d6006b;color:#fff;border:none;font-size:.95rem;font-weight:700;padding:.75rem 1.25rem;border-radius:.6rem;margin-top:1rem}
button:hover{background:#b0005a}a{color:#d6006b}</style></head>
<body><div class="card"><div style="font-size:2rem;margin-bottom:1rem">${icon}</div><h1>${heading}</h1>${bodyHtml}</div></body></html>`,
});

const BASE = () => (process.env.BASE_URL || '').replace(/\/$/, '');
const settingsLink = () => `<p style="margin-top:1.5rem"><a href="${BASE()}/workspace.html?view=settings">Manage all your email preferences →</a></p>`;

export default withLambda(async (event) => {
    if (event.httpMethod === 'HEAD') return { statusCode: 200, body: '' };
    const u = Number(event.queryStringParameters?.u);
    const s = String(event.queryStringParameters?.s || '');
    if (!Number.isInteger(u) || u <= 0 || !verifyUnsubscribeSignature(u, s)) {
        return page(400, 'This link is not valid', '<p>It may have been copied incompletely. You can turn these emails off in your account settings instead.</p>' + settingsLink(), '⚠️');
    }

    if (event.httpMethod === 'GET') {
        return page(200, "Unsubscribe from \"What's new\"?",
            `<p>You'll stop getting our weekly email about new features. Emails about your account, billing and security still arrive as usual.</p>
             <form method="POST"><button type="submit">Unsubscribe</button></form>`, '✉️');
    }

    if (event.httpMethod === 'POST') {
        try {
            // Merge, never replace: the other keys are this person's choices about other emails.
            await getDb().insert(userProfiles)
                .values({ userId: u, emailPreferences: { whats_new: false } })
                .onConflictDoUpdate({
                    target: userProfiles.userId,
                    set: { emailPreferences: sql`coalesce(${userProfiles.emailPreferences}, '{}'::jsonb) || '{"whats_new": false}'::jsonb` },
                });
        } catch (err) {
            // A person who asked to leave must be told if it did not work, not shown a success page.
            console.error('[product-update-unsubscribe] FAILED — this user may be emailed again:', { userId: u }, err);
            return page(500, 'Something went wrong', '<p>We could not save that just now. Please try again, or reply to the email and we will do it for you.</p>', '⚠️');
        }
        return page(200, "You've been unsubscribed", `<p>You won't get any more "What's new" emails. Changed your mind? Turn them back on in your account settings.</p>` + settingsLink(), '✅');
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
});
