import { Handler } from '@netlify/functions';
import { eq } from 'drizzle-orm';
import * as crypto from 'crypto';
import { getDb, withUpdatedAt } from '../../db/client';
import { users } from '../../db/schema';
import { sendMagicLinkEmail } from '../../src/utils/email';
import { resolveBaseUrl } from '../../src/utils/base-url';

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const body = JSON.parse(event.body || '{}');

        if (!body.email) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Email is required.' }) };
        }

        // Normalize the email to prevent silent case-mismatch failures
        const email = body.email.trim().toLowerCase();
        const db = getDb();

        // 1. Find the user by normalized email
        const [existingUser] = await db.select()
            .from(users)
            .where(eq(users.email, email))
            .limit(1);

        if (!existingUser) {
            return { statusCode: 200, body: JSON.stringify({ message: 'If an account exists, a new link has been sent.' }) };
        }

        if (existingUser.status === 'active') {
            return { statusCode: 400, body: JSON.stringify({ error: 'This account is already verified. Please sign in.' }) };
        }

        // 2. Generate a plain token for the email link, and a hashed token for the database
        const plainToken = crypto.randomBytes(32).toString('hex');
        const hashedToken = crypto.createHash('sha256').update(plainToken).digest('hex');
        const newTokenExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

        // 3. Update the user record with the HASHED token
        await db.update(users)
            .set(withUpdatedAt({
                verificationToken: hashedToken,
                tokenExpiresAt: newTokenExpiresAt,
            }))
            .where(eq(users.id, existingUser.id));

        // 4. Construct the link and send the email
        const baseUrl = resolveBaseUrl(event.headers);
        if (!baseUrl) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

        // Ensure we send the PLAIN token in the URL, not the hash
        const magicLink = `${baseUrl}/verify-account.html?token=${plainToken}`;

        await sendMagicLinkEmail({
            to: email,
            subject: 'Your New Be More Swan Verification Link',
            html: `
                <div style="font-family: sans-serif; text-align: center; padding: 40px 20px; background-color: #fdfcf9;">
                    <div style="max-width: 500px; margin: 0 auto; background-color: white; padding: 40px; border-radius: 16px; border: 1px solid #eae4d7; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
                        <h2 style="color: #1f1e1b; margin-top: 0;">Verify your Account</h2>
                        <p style="color: #5c564b; font-size: 16px; line-height: 1.5;">You requested a new verification link. Click the button below to securely verify your account and complete your workspace setup.</p>
                        <a href="${magicLink}" style="background-color: #00e55c; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; display: inline-block; margin: 24px 0; font-weight: bold; font-size: 16px;">
                            Verify Account
                        </a>
                        <p style="color: #787263; font-size: 14px; margin-bottom: 0;">This secure link expires in 24 hours.</p>
                    </div>
                </div>
            `
        });

        return {
            statusCode: 200,
            body: JSON.stringify({
                message: 'A new verification link has been sent to your email.'
            }),
        };
    } catch (error) {
        console.error('Resend Error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to resend verification email.' }) };
    }
};