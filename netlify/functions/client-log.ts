import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { withLambda } from '@netlify/aws-lambda-compat';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const body = JSON.parse(event.body || '{}');
        const { event: eventName, error, path } = body;

        let userId = 'unauthenticated';
        const jwtSecret = process.env.JWT_SECRET;
        if (jwtSecret) {
            const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
            if (match) {
                try {
                    const payload = jwt.verify(match[1], jwtSecret) as { userId?: number };
                    if (payload.userId) userId = String(payload.userId);
                } catch { /* invalid token — leave as unauthenticated */ }
            }
        }

        console.error(`[client-log] userId=${userId} event=${eventName} error=${error} path=${path}`);

        return { statusCode: 204, body: '' };
    } catch {
        return { statusCode: 204, body: '' };
    }
});
