import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, organisations, userOrganisations } from '../../db/schema';

const jwtSecret = process.env.JWT_SECRET!;

export const handler: Handler = async (event) => {
    const cookieHeader = event.headers.cookie || '';
    const match = cookieHeader.match(/aura_session=([^;]+)/);
    const token = match ? match[1] : null;
    if (!token) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };

    try {
        const decoded = jwt.verify(token, jwtSecret) as { userId: number };
        const db = getDb();

        // Onboarding is complete when the workspace's onboarding_completed flag is set
        // (the 3-step widget, US1.1). Fall back to assistant-existence for older workspaces
        // whose flag predates the gamification migration (and was backfilled there anyway).
        const [org] = await db
            .select({ onboardingCompleted: organisations.onboardingCompleted })
            .from(userOrganisations)
            .leftJoin(organisations, eq(userOrganisations.organisationId, organisations.id))
            .where(eq(userOrganisations.userId, decoded.userId))
            .limit(1);

        let isComplete = org?.onboardingCompleted === true;
        if (!isComplete) {
            const [assistant] = await db
                .select({ id: aiAssistants.id })
                .from(aiAssistants)
                .where(eq(aiAssistants.userId, decoded.userId))
                .limit(1);
            isComplete = !!assistant;
        }

        return {
            statusCode: 200,
            body: JSON.stringify({ isComplete, status: isComplete ? 100 : 0 })
        };
    } catch (e) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Server error' }) };
    }
};
