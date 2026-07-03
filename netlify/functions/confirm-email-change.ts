// netlify/functions/confirm-email-change.ts
//
// US-ADM-1.1.1: Email address change double-opt-in confirmation
//
// GET /.netlify/functions/confirm-email-change?token=<hex>&uid=<id>
//
// Called when the user clicks the confirmation link sent to their NEW email address.
// Validates the token stored in verificationToken, then swaps the email address.

import { Handler } from '@netlify/functions';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users } from '../../db/schema';
import { insertAdminAuditLog } from '../../src/utils/admin-audit';

const SITE_URL = process.env.BASE_URL || 'https://bemoreswan.com';

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const { token, uid: uidStr } = event.queryStringParameters || {};
    if (!token || !uidStr) {
        return htmlError('Invalid link — missing parameters.');
    }

    const uid = parseInt(uidStr, 10);
    if (isNaN(uid)) {
        return htmlError('Invalid link — bad user id.');
    }

    const db = getDb();
    const [user] = await db
        .select({ id: users.id, email: users.email, verificationToken: users.verificationToken, tokenExpiresAt: users.tokenExpiresAt })
        .from(users)
        .where(eq(users.id, uid))
        .limit(1);

    if (!user || !user.verificationToken) {
        return htmlError('This confirmation link is invalid or has already been used.');
    }

    // verificationToken format: "emailchange:{base64payload}:{confirmToken}"
    const parts = user.verificationToken.split(':');
    if (parts.length < 3 || parts[0] !== 'emailchange') {
        return htmlError('Invalid confirmation link.');
    }

    const storedToken = parts[parts.length - 1];
    if (storedToken !== token) {
        return htmlError('This confirmation link is invalid or has already been used.');
    }

    // Check expiry
    if (user.tokenExpiresAt && new Date(user.tokenExpiresAt) < new Date()) {
        return htmlError('This confirmation link has expired (24-hour limit). Please ask an admin to resend the request.');
    }

    // Decode payload
    let newEmail: string;
    let adminId: number;
    try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
        newEmail = payload.newEmail;
        adminId = payload.adminId;
    } catch {
        return htmlError('Could not decode confirmation payload. Please contact support.');
    }

    // Final duplicate check
    const [existing] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, newEmail))
        .limit(1);

    if (existing && existing.id !== uid) {
        return htmlError('The new email address is already in use by another account. Please contact support.');
    }

    // Perform the swap
    const oldEmail = user.email;
    await db.update(users)
        .set({ email: newEmail, verificationToken: null, tokenExpiresAt: null, updatedAt: new Date() })
        .where(eq(users.id, uid));

    // Write a completion audit log entry
    await insertAdminAuditLog({
        adminId,
        action: 'email_change',
        targetType: 'user',
        targetId: uid,
        previousState: { email: oldEmail },
        newState: { email: newEmail, status: 'confirmed' },
        reason: 'Double-opt-in confirmed by user',
    }).catch(() => {});

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'text/html' },
        body: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Email address updated — Be More Swan</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           display: flex; align-items: center; justify-content: center;
           min-height: 100vh; background: #f0fdf4; margin: 0; }
    .card { background: #fff; border-radius: 12px; padding: 2.5rem; max-width: 420px;
            text-align: center; box-shadow: 0 4px 20px rgba(0,0,0,.08); }
    h1 { color: #16a34a; margin-top: 0; }
    p  { color: #374151; line-height: 1.6; }
    a  { display: inline-block; margin-top: 1rem; padding: .75rem 1.75rem;
         background: #4f46e5; color: #fff; border-radius: 8px; text-decoration: none; }
  </style>
</head>
<body>
  <div class="card">
    <h1>✅ Email address updated</h1>
    <p>Your Be More Swan account email address has been successfully changed to <strong>${escHtml(newEmail)}</strong>.</p>
    <p>You can now sign in using your new email address.</p>
    <a href="${SITE_URL}/login.html">Go to login</a>
  </div>
</body>
</html>`,
    };
};

function htmlError(message: string) {
    return {
        statusCode: 400,
        headers: { 'Content-Type': 'text/html' },
        body: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Error — Be More Swan</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           display: flex; align-items: center; justify-content: center;
           min-height: 100vh; background: #fef2f2; margin: 0; }
    .card { background: #fff; border-radius: 12px; padding: 2.5rem; max-width: 420px;
            text-align: center; box-shadow: 0 4px 20px rgba(0,0,0,.08); }
    h1 { color: #dc2626; margin-top: 0; }
    p  { color: #374151; }
    a  { color: #4f46e5; }
  </style>
</head>
<body>
  <div class="card">
    <h1>❌ Confirmation failed</h1>
    <p>${escHtml(message)}</p>
    <p><a href="mailto:support@bemoreswan.com">Contact support</a></p>
  </div>
</body>
</html>`,
    };
}

function escHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
