// netlify/functions/dashboard-agenda.ts
// GET → { items: [{ kind, at, label, assistantId, assistantName }], total }
// The dashboard's "Next 7 days" widget: everything already booked to go out, across every assistant.
//
// Why: each assistant's Calendar tab shows only that assistant, so nothing answered "what goes out
// this week?" for the whole team. Reads only rows that WILL happen without anyone acting — a
// scheduled post, a scheduled article, a scheduled email. Drafts and items awaiting approval are
// deliberately absent: they are not booked, and the "Needs you" strip already counts them.
// The reading lives in src/utils/team-activity.ts (loadBooked), which every assistant's chat also
// reads — status 'scheduled' in every source.

import { eq } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { aiAssistants } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { loadBooked } from '../../src/utils/team-activity';

const DAYS = 7;
const PER_KIND = 20;
const MAX_ITEMS = 12;

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const orgId = ctx.organisationId;
    const now = new Date();

    const team = new Map((await db.select({ id: aiAssistants.id, name: aiAssistants.name })
        .from(aiAssistants).where(eq(aiAssistants.organisationId, orgId))).map((a) => [a.id, a.name]));
    const booked = await loadBooked(db, orgId, now, new Date(now.getTime() + DAYS * 24 * 60 * 60 * 1000), PER_KIND);
    const items = booked.map((b) => ({ ...b, assistantName: b.assistantId != null ? team.get(b.assistantId) ?? null : null }));

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: items.slice(0, MAX_ITEMS), total: items.length }),
    };
});
