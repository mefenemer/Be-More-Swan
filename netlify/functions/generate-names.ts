// netlify/functions/generate-names.ts
import { HandlerEvent } from '@netlify/functions';
import Anthropic from '@anthropic-ai/sdk';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, userOrganisations } from '../../db/schema';
import { logAiUsage } from '../../src/utils/ai-usage';
import { isGlobalAiDisabled } from '../../src/utils/platform-config';

const jwtSecret = process.env.JWT_SECRET;
const MODEL = 'claude-haiku-4-5-20251001';

export const handler = async (event: HandlerEvent) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    // US-ADM-3.2.1: Global AI kill switch
    if (await isGlobalAiDisabled()) {
        return { statusCode: 503, body: JSON.stringify({ error: 'AI services are temporarily unavailable. Please try again later.' }) };
    }

    // 1. Authenticate Session
    const rawCookieHeader = event.headers.cookie || '';
    const cookies = Object.fromEntries(
        rawCookieHeader.split(';').map(c => {
            const [key, ...v] = c.trim().split('=');
            return [key, decodeURIComponent(v.join('='))];
        }).filter(([key]) => key !== '')
    );

    const sessionToken = cookies['aura_session'];
    if (!sessionToken) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    let decoded: { userId: number };
    try {
        decoded = jwt.verify(sessionToken, jwtSecret) as { userId: number };
    } catch (err) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    // Fetch org context for AI metadata tagging (US12)
    const db = getDb();
    const [userRow] = await db
        .select({ id: users.id, organisationId: userOrganisations.organisationId })
        .from(users)
        .leftJoin(userOrganisations, eq(users.id, userOrganisations.userId))
        .where(eq(users.id, decoded.userId))
        .limit(1);
    const orgId = userRow?.organisationId ?? null;

    const { theme, role } = JSON.parse(event.body || '{}');
    if (!theme || !role) return { statusCode: 400, body: JSON.stringify({ error: 'Theme and Role are required.' }) };

    try {
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

        const response = await anthropic.messages.create({
            model: MODEL,
            max_tokens: 256,
            messages: [{
                role: 'user',
                content: `You are a creative naming assistant for an AI software platform. The user wants to name their new AI Assistant. The assistant's role is "${role}" and the creative theme is "${theme}". Return EXACTLY 3 to 5 unique, catchy, and professional name suggestions. Return ONLY a valid JSON array of strings (e.g. ["Name 1", "Name 2", "Name 3"]). Do not include markdown formatting, explanations, or extra text.`
            }],
        });

        const raw = (response.content[0] as { text: string }).text.trim();
        const jsonMatch = raw.match(/\[[\s\S]*\]/);
        const names = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
        if (!Array.isArray(names) || names.length === 0) throw new Error('Invalid LLM response format.');

        // US-ADM-3.1.1: fire-and-forget usage log
        void logAiUsage({
            userId:      decoded.userId,
            workspaceId: orgId,
            model:       MODEL,
            inputTokens:  response.usage?.input_tokens  ?? 0,
            outputTokens: response.usage?.output_tokens ?? 0,
        });

        // 2. Return clean array
        return { statusCode: 200, body: JSON.stringify({ names }) };

    } catch (error) {
        console.error('Name Generation Error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Our creative gears are jammed right now. Please type a name manually!' }) };
    }
};
