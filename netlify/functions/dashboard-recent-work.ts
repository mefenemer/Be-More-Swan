// netlify/functions/dashboard-recent-work.ts
// GET → { items: [{ id, assistantId, assistantName, icon, description, createdAt, status }] }
// The dashboard's "Recent work" widget: the last 7 days of what EVERY assistant did, newest first.
//
// Why: the dashboard's only cross-assistant feed was "Latest updates", which reads notifications —
// and on prod those were all "Post published to …" (dashboard review 2026-10-09). Emails sent,
// articles published, campaign orders, briefs, leads contacted and every records role's work never
// appeared there. The reading itself lives in src/utils/team-activity.ts, which every assistant's
// chat also reads as <team_activity> — one definition of "what the team did", so the dashboard and
// the assistants cannot disagree about it.
// Bounded: a handful of rows per assistant, so cost grows with the team, not with its history.

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { requireTenant } from '../../src/utils/tenant';
import type { ActivityItem } from '../../src/utils/role-activity';
import { loadTeam, recentWorkFor } from '../../src/utils/team-activity';

const DAYS = 7;
const PER_ASSISTANT = 6;
const MAX_ITEMS = 10;

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const orgId = ctx.organisationId;
    const cutoff = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);

    const team = await loadTeam(db, orgId);
    const out: Array<ActivityItem & { assistantId: number; assistantName: string }> = [];

    await Promise.all(team.map(async (a) => {
        try {
            for (const it of await recentWorkFor(db, orgId, a, cutoff, PER_ASSISTANT)) out.push({ ...it, assistantId: a.id, assistantName: a.name });
        } catch (err) {
            // One assistant's source failing must not empty the widget for the others.
            console.error('[dashboard-recent-work] assistant skipped', a.id, err);
        }
    }));

    out.sort((x, y) => new Date(y.createdAt).getTime() - new Date(x.createdAt).getTime());
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: out.slice(0, MAX_ITEMS) }) };
});
