import { Handler } from '@netlify/functions';
import { getDb } from '../../db/client';
import { userProfiles } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';

export default withLambda(async (event) => {
    const standardHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
    };

    const AUTHENTICATED_USER_ID = 1;

    try {
        const db = getDb();

        if (event.httpMethod === 'GET') {
            const profile = await db.select().from(userProfiles).where(eq(userProfiles.userId, AUTHENTICATED_USER_ID)).limit(1);
            if (!profile.length) {
                const newProfile = await db.insert(userProfiles).values({
                    userId: AUTHENTICATED_USER_ID,
                    timezone: 'Europe/Athens',
                    notifyWins: true,
                    notifyBilling: true,
                    notifyAvailability: false
                }).returning();
                return { statusCode: 200, headers: standardHeaders, body: JSON.stringify({
                        notifyWins: newProfile[0].notifyWins, notifyBilling: newProfile[0].notifyBilling, notifyAvailability: newProfile[0].notifyAvailability
                    })};
            }
            return { statusCode: 200, headers: standardHeaders, body: JSON.stringify({
                    notifyWins: profile[0].notifyWins, notifyBilling: profile[0].notifyBilling, notifyAvailability: profile[0].notifyAvailability
                })};
        }

        if (event.httpMethod === 'PATCH') {
            if (!event.body) return { statusCode: 400, headers: standardHeaders, body: JSON.stringify({ error: 'Missing payload.' }) };
            const { preferenceKey, value } = JSON.parse(event.body);

            const validKeys = ['notifyWins', 'notifyBilling', 'notifyAvailability'];
            if (!validKeys.includes(preferenceKey)) return { statusCode: 400, headers: standardHeaders, body: JSON.stringify({ error: 'Invalid preference key.' }) };

            const profileCheck = await db.select().from(userProfiles).where(eq(userProfiles.userId, AUTHENTICATED_USER_ID)).limit(1);
            if (!profileCheck.length) {
                const baseInsert = {
                    userId: AUTHENTICATED_USER_ID,
                    timezone: 'Europe/Athens',
                    notifyWins: preferenceKey === 'notifyWins' ? value : true,
                    notifyBilling: preferenceKey === 'notifyBilling' ? value : true,
                    notifyAvailability: preferenceKey === 'notifyAvailability' ? value : false
                };
                await db.insert(userProfiles).values(baseInsert);
            } else {
                const updatePayload: Record<string, boolean> = {};
                updatePayload[preferenceKey] = value;
                await db.update(userProfiles).set(updatePayload).where(eq(userProfiles.userId, AUTHENTICATED_USER_ID));
            }
            return { statusCode: 200, headers: standardHeaders, body: JSON.stringify({ success: true }) };
        }
        return { statusCode: 405, headers: standardHeaders, body: 'Method Not Allowed' };
    } catch (error: any) {
        console.error('Notification update rejection:', error);
        return { statusCode: 500, headers: standardHeaders, body: JSON.stringify({ error: error.message || 'Database execution failed.' }) };
    }
});