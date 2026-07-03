// safety-feedback.ts — Receives user suggestions for the Be More Swan Safe Content Benchmark
// Inserts to support_tickets with category = 'Safety_Benchmark_Feedback'
// Admin review only — suggestions do NOT auto-apply to the benchmark

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, supportTickets, userOrganisations } from '../../db/schema';

const jwtSecret = process.env.JWT_SECRET;

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    // Auth
    const cookieHeader = event.headers.cookie || '';
    const sessionToken = cookieHeader.match(/aura_session=([^;]+)/)?.[1];
    if (!sessionToken) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    let userId: number;
    try {
        userId = (jwt.verify(sessionToken, jwtSecret) as { userId: number }).userId;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    try {
        const db = getDb();

        const [user] = await db.select({
            id: users.id,
            organisationId: userOrganisations.organisationId,
        }).from(users).leftJoin(userOrganisations, eq(users.id, userOrganisations.userId)).where(eq(users.id, userId));

        if (!user) return { statusCode: 403, body: JSON.stringify({ error: 'User not found.' }) };

        const body = JSON.parse(event.body || '{}');
        const { suggestion, context } = body;

        if (!suggestion || !suggestion.trim()) {
            return { statusCode: 400, body: JSON.stringify({ error: 'A suggestion is required.' }) };
        }

        const description = context?.trim()
            ? `SUGGESTION:\n${suggestion.trim()}\n\nADDITIONAL CONTEXT:\n${context.trim()}`
            : suggestion.trim();

        await db.insert(supportTickets).values({
            userId: user.id,
            organisationId: user.organisationId ?? null,
            subject: 'Safety Benchmark Suggestion',
            category: 'Safety_Benchmark_Feedback',
            description,
            status: 'open',
        });

        return {
            statusCode: 200,
            body: JSON.stringify({ success: true, message: 'Thank you — your suggestion has been submitted for review.' }),
        };
    } catch (err) {
        console.error('Safety Feedback Error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal Server Error' }) };
    }
};
