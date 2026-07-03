// netlify/functions/account-delete-request.ts
// US-GAP-2.1.1: User Requests Account Deletion
//
//  POST { confirm: 'DELETE' }  → SC2/SC4: initiates 24h cooling-off period
//  DELETE (cancel token)       → served by account-delete-cancel.ts

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import Stripe from 'stripe';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, plans } from '../../db/schema';
import { sendEmail } from '../../src/utils/email';
import { checkImpersonationBlock } from '../../src/utils/impersonation-guard';

const jwtSecret = process.env.JWT_SECRET!;
const stripe    = process.env.STRIPE_SECRET_KEY
    ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2026-05-27.dahlia' })
    : null;
const BASE_URL  = process.env.BASE_URL || '';

function parseSession(event: any): number | null {
    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return null;
    try { return (jwt.verify(match[1], jwtSecret) as { userId: number }).userId; } catch { return null; }
}

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    // US-ADM-1.2.1: Block account deletion during impersonation sessions
    const impersonationBlock = checkImpersonationBlock(event);
    if (impersonationBlock) return impersonationBlock;

    const userId = parseSession(event);
    if (!userId) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    const db   = getDb();
    const body = JSON.parse(event.body || '{}');

    // SC2: require typing 'DELETE' to confirm
    if (body.confirm !== 'DELETE') {
        return { statusCode: 400, body: JSON.stringify({ error: 'Please type DELETE to confirm account deletion.' }) };
    }

    // Fetch user
    const [user] = await db
        .select({ id: users.id, email: users.email, firstName: users.firstName, pendingDeletion: users.pendingDeletion })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
    if (!user) return { statusCode: 404, body: JSON.stringify({ error: 'User not found.' }) };

    // Idempotent — if already pending, resend the email
    const plainToken   = crypto.randomBytes(32).toString('hex');
    const hashedToken  = crypto.createHash('sha256').update(plainToken).digest('hex');
    const pendingAt    = new Date();

    await db.update(users)
        .set({
            pendingDeletion:   true,
            pendingDeletionAt: pendingAt,
            deletionToken:     hashedToken,
            updatedAt:         new Date(),
        })
        .where(eq(users.id, userId));

    // SC3: check for active subscription
    const [activePlan] = await db
        .select({ id: plans.id, stripeSubscriptionId: plans.stripeSubscriptionId })
        .from(plans)
        .where(and(eq(plans.userId, userId), eq(plans.status, 'active')))
        .limit(1);

    const subWarning = activePlan
        ? `<p style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px;color:#991b1b;font-size:0.875rem;">
             ⚠️ <strong>Active subscription:</strong> Your subscription will be cancelled immediately with no refund for the remaining billing period.
           </p>`
        : '';

    const cancelUrl = `${BASE_URL}/.netlify/functions/account-delete-cancel?token=${plainToken}`;

    // SC4: send cooling-off email with cancel link
    sendEmail({
        to: user.email,
        subject: 'Account deletion requested — cancel within 24 hours',
        html: `<p>Hi ${user.firstName || 'there'},</p>
               <p>We've received your request to permanently delete your Be More Swan account.</p>
               ${subWarning}
               <p><strong>What will be deleted:</strong></p>
               <ul style="padding-left:1.2rem;line-height:1.8;font-size:0.9rem;color:#6b7280;">
                 <li>Your profile and personal information</li>
                 <li>All AI assistants and their configurations</li>
                 <li>Generated content and scheduled posts</li>
                 <li>Billing records and invoices</li>
               </ul>
               <p><strong>Your account will be permanently deleted in 24 hours.</strong> If you changed your mind, click the button below to cancel:</p>
               <p style="margin-top:20px;">
                 <a href="${cancelUrl}" style="background:#059669;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">
                   Cancel Deletion →
                 </a>
               </p>
               <p style="font-size:0.75rem;color:#9ca3af;margin-top:16px;">This link is valid for 24 hours. After that, deletion is irreversible.</p>
               <p>The Be More Swan Team</p>`,
    }).catch(err => console.warn('[account-delete-request] Email failed:', err));

    return {
        statusCode: 200,
        body: JSON.stringify({
            success: true,
            message: 'Your deletion request has been received. Check your email for a cancellation link — your account will be permanently deleted in 24 hours.',
        }),
    };
};
