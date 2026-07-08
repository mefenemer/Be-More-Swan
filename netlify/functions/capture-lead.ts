import { Handler } from '@netlify/functions';
import { getDb } from '../../db/client';
import { leads } from '../../db/schema';
import { withLambda } from '@netlify/aws-lambda-compat';

const URGENCY_TO_PRIORITY: Record<string, string> = {
    'This week':    'high',
    'Next month':   'medium',
    'Just exploring': 'low',
};

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    try {
        const body = JSON.parse(event.body || '{}');
        const rawEmail = body.email || '';
        const role = body.role || '';

        const email = rawEmail.trim().toLowerCase();

        if (!email || !email.includes('@') || !role) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Valid email and role are required.' }) };
        }

        const db = getDb();

        const name      = (body.name      || '').trim() || null;
        const company   = (body.company   || '').trim() || null;
        const teamSize  = (body.teamSize  || '').trim() || null;
        const useCase   = (body.useCase   || '').trim() || null;
        const leadType  = (body.leadType  || '').trim() || null;
        const source    = (body.source    || '').trim() || null;
        const userId    = body.userId ? Number(body.userId) : null;
        const urgency   = (body.urgency   || '').trim();

        const priority  = URGENCY_TO_PRIORITY[urgency] ?? (body.priority || null);

        const opportunityReason = (body.opportunityReason || '').trim()
            || `Interest in the ${role} Role`;

        const actionText = role === 'Enterprise'
            ? `Enterprise discovery call requested — ${company || 'unknown company'}, ${teamSize || 'unknown size'}: ${(useCase || '').slice(0, 120) || 'no use case provided'}`
            : leadType === 'role_request'
                ? `Role request: ${role}`
                : 'notify user of AI Assistant readiness';

        await db.insert(leads)
            .values({
                email,
                opportunityReason,
                action: actionText,
                leadType,
                source,
                userId,
                name,
                company,
                teamSize,
                useCase,
                priority,
            })
            .onConflictDoUpdate({
                target: [leads.email, leads.opportunityReason],
                set: {
                    leadType,
                    source,
                    useCase,
                    company,
                    priority,
                    updatedAt: new Date(),
                },
            });

        return {
            statusCode: 200,
            body: JSON.stringify({ success: true, message: 'Lead captured successfully.' }),
        };
    } catch (error) {
        console.error('Lead Capture Error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'An internal error occurred while saving your interest.' }),
        };
    }
});
