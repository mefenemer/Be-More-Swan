import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, workspaceAssets, userProfiles, userOrganisations } from '../../db/schema';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    const cookieHeader = event.headers.cookie || '';
    const token = cookieHeader.match(/aura_session=([^;]+)/)?.[1];
    if (!token || !jwtSecret) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    let currentUserId: number;
    try {
        currentUserId = (jwt.verify(token, jwtSecret) as { userId: number }).userId;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    const db = getDb();

    // Get user's orgId
    const [user] = await db
        .select({ organisationId: userOrganisations.organisationId })
        .from(userOrganisations)
        .where(eq(userOrganisations.userId, currentUserId))
        .limit(1);

    if (!user?.organisationId) {
        return { statusCode: 200, body: JSON.stringify({ assistantRules: [], brandProfile: null }) };
    }

    // Fetch assistant rules from workspaceAssets (text type)
    const ruleRows = await db
        .select({
            id: workspaceAssets.id,
            category: workspaceAssets.category,
            extractedText: workspaceAssets.extractedText,
            isActive: workspaceAssets.isActive,
            priority: workspaceAssets.priority,
        })
        .from(workspaceAssets)
        .where(
            and(
                eq(workspaceAssets.organisationId, user.organisationId),
                eq(workspaceAssets.assetType, 'text')
            )
        )
        .orderBy(workspaceAssets.category, workspaceAssets.priority);

    // Flatten into a list of rules with stable string IDs for per-assistant toggles
    const assistantRules = ruleRows
        .filter(r => r.extractedText && r.extractedText.trim() !== '')
        .map(r => ({
            id: String(r.id),         // stable DB id — used as key in appliedDefaults
            text: r.extractedText!,
            category: r.category,
            isActive: r.isActive,     // global toggle state from the instructions page
        }));

    // Fetch brand profile from userProfiles.preferences
    const [profile] = await db
        .select({ preferences: userProfiles.preferences })
        .from(userProfiles)
        .where(eq(userProfiles.userId, currentUserId))
        .limit(1);

    const brandProfile = (profile?.preferences as any)?.brandProfile || null;

    return {
        statusCode: 200,
        body: JSON.stringify({ assistantRules, brandProfile }),
    };
});
