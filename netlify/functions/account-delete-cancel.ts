// netlify/functions/account-delete-cancel.ts
// US-GAP-2.1.1 SC6: Cancel pending account deletion via email link
//
// GET ?token=<plainToken>  → clears pendingDeletion flag, restores account

import { Handler } from '@netlify/functions';
import * as crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users } from '../../db/schema';

const BASE_URL = process.env.BASE_URL || '';

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    const plainToken = event.queryStringParameters?.token;
    if (!plainToken) {
        return { statusCode: 400, headers: { 'Content-Type': 'text/html' }, body: '<p>Invalid cancellation link.</p>' };
    }

    const hashedToken = crypto.createHash('sha256').update(plainToken).digest('hex');
    const db = getDb();

    const [user] = await db
        .select({ id: users.id, pendingDeletion: users.pendingDeletion, pendingDeletionAt: users.pendingDeletionAt, deletionToken: users.deletionToken })
        .from(users)
        .where(eq(users.deletionToken, hashedToken))
        .limit(1);

    if (!user) {
        return {
            statusCode: 400,
            headers: { 'Content-Type': 'text/html' },
            body: `<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px 20px;">
                   <h2>Invalid or expired link</h2>
                   <p>This cancellation link is no longer valid. If your account was already deleted, please contact <a href="mailto:hello@bemoreswan.com">support</a>.</p>
                   </body></html>`,
        };
    }

    // Check 24h window
    const requestedAt = user.pendingDeletionAt instanceof Date
        ? user.pendingDeletionAt
        : user.pendingDeletionAt ? new Date(user.pendingDeletionAt as string) : null;
    const expired = requestedAt && (Date.now() - requestedAt.getTime() > 24 * 60 * 60 * 1000);

    if (expired) {
        return {
            statusCode: 410,
            headers: { 'Content-Type': 'text/html' },
            body: `<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px 20px;">
                   <h2>Cancellation window expired</h2>
                   <p>The 24-hour cancellation window has passed. Please <a href="mailto:hello@bemoreswan.com">contact support</a> if you believe this is an error.</p>
                   </body></html>`,
        };
    }

    // SC6: Restore account
    await db.update(users)
        .set({
            pendingDeletion:   false,
            pendingDeletionAt: null,
            deletionToken:     null,
            updatedAt:         new Date(),
        })
        .where(eq(users.id, user.id));

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'text/html' },
        body: `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Deletion Cancelled — Be More Swan</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f9fafb}
.card{background:#fff;border-radius:1rem;padding:2.5rem;max-width:420px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08)}
h1{font-size:1.25rem;margin-bottom:.5rem}p{color:#6b7280;font-size:.9rem}a{color:#059669;font-weight:bold}</style></head>
<body><div class="card">
  <div style="font-size:2.5rem;margin-bottom:1rem">✅</div>
  <h1>Account deletion cancelled</h1>
  <p>Your account is safe. Nothing has been changed and all your assistants and data remain intact.</p>
  <p style="margin-top:1.5rem"><a href="${BASE_URL}/workspace.html">Return to your workspace →</a></p>
</div></body></html>`,
    };
};
