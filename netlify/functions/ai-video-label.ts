// netlify/functions/ai-video-label.ts
// The workspace's "Made with AI" caption line for realistic AI video (owner, 2026-11-11; src/utils/ai-disclosure.ts).
//
//   GET                        → { enabled }
//   PATCH { enabled: boolean } → { enabled }
//
// Scoped to the workspace the person has open (requireTenant), not their first membership. The same action
// as the chat's ai_video_label_setting card.

import { eq } from 'drizzle-orm';
import { getDb, withUpdatedAt } from '../../db/client';
import { organisations } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { withLambda } from '@netlify/aws-lambda-compat';

const json = (statusCode: number, body: unknown) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export default withLambda(async (event) => {
    if (!['GET', 'PATCH'].includes(event.httpMethod)) return json(405, { error: 'Method Not Allowed' });
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const orgId = ctx.organisationId;
    if (event.httpMethod === 'PATCH') {
        let body: { enabled?: unknown };
        try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }
        if (typeof body.enabled !== 'boolean') return json(400, { error: 'enabled must be true or false.' });
        await db.update(organisations).set(withUpdatedAt({ aiVideoLabelEnabled: body.enabled })).where(eq(organisations.id, orgId));
    }
    const [row] = await db.select({ enabled: organisations.aiVideoLabelEnabled }).from(organisations).where(eq(organisations.id, orgId)).limit(1);
    return json(200, { enabled: row?.enabled ?? true });
});
