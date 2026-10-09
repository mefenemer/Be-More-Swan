// netlify/functions/dashboard-recent-work.ts
// GET → { items: [{ id, assistantId, assistantName, icon, description, createdAt, status }] }
// The dashboard's "Recent work" widget: the last 7 days of what EVERY assistant did, newest first.
//
// Why: the dashboard's only cross-assistant feed was "Latest updates", which reads notifications —
// and on prod those were all "Post published to …" (dashboard review 2026-10-09). Emails sent,
// articles published, campaign orders, briefs, leads contacted and every records role's work never
// appeared there. This reads the same sources each assistant's own Activity tab reads:
//   • src/utils/role-activity.ts for the roles whose work is not posts,
//   • published scheduled_posts for the Social Media Assistant,
//   • the revenue ledger (describeLeadEvent) for the Lead Generator — the get-lead-activity source.
// Bounded: a handful of rows per assistant, so cost grows with the team, not with its history.

import { and, desc, eq, gte, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { aiAssistants, assistantRecords, revenueEvents, scheduledPosts } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { roleActivityItems, type ActivityItem } from '../../src/utils/role-activity';
import { describeLeadEvent } from '../../src/config/lead-activity-events';

const DAYS = 7;
const PER_ASSISTANT = 6;
const MAX_ITEMS = 10;
const PLATFORM_NAMES: Record<string, string> = { instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn', x: 'X', threads: 'Threads', tiktok: 'TikTok', youtube: 'YouTube', pinterest: 'Pinterest' };

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const orgId = ctx.organisationId;
    const cutoff = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);

    const team = await db.select({ id: aiAssistants.id, name: aiAssistants.name, roleKey: sql<string | null>`${aiAssistants.configuration} ->> 'type'` })
        .from(aiAssistants).where(and(eq(aiAssistants.organisationId, orgId), ne(aiAssistants.lifecycleStatus, 'archived')));
    const out: Array<ActivityItem & { assistantId: number; assistantName: string }> = [];

    await Promise.all(team.map(async (a) => {
        try {
            const items: ActivityItem[] = [];
            if (a.roleKey === 'social_media_manager') {
                const posts = await db.select({ id: scheduledPosts.id, platform: scheduledPosts.platform, publishedAt: scheduledPosts.publishedAt })
                    .from(scheduledPosts).where(and(
                        eq(scheduledPosts.organisationId, orgId), eq(scheduledPosts.assistantId, a.id), eq(scheduledPosts.status, 'published'),
                        isNotNull(scheduledPosts.publishedAt), gte(scheduledPosts.publishedAt, cutoff),
                    )).orderBy(desc(scheduledPosts.publishedAt)).limit(PER_ASSISTANT);
                for (const p of posts) items.push({ id: `post-${p.id}`, type: 'post_published', icon: 'rocket', description: `Published a post to ${PLATFORM_NAMES[p.platform] ?? p.platform}.`, createdAt: p.publishedAt!, status: 'success' });
            } else if (a.roleKey === 'lead_qualifier') {
                const events = await db.select({
                    id: revenueEvents.id, eventType: revenueEvents.eventType, outcome: revenueEvents.outcome, lossReason: revenueEvents.lossReason,
                    valueGbp: revenueEvents.valueGbp, payload: revenueEvents.payload, assistantRecordId: revenueEvents.assistantRecordId, occurredAt: revenueEvents.occurredAt,
                }).from(revenueEvents).where(and(
                    eq(revenueEvents.organisationId, orgId), eq(revenueEvents.aiAssistantId, a.id), gte(revenueEvents.occurredAt, cutoff),
                )).orderBy(desc(revenueEvents.occurredAt)).limit(PER_ASSISTANT * 3);
                const ids = [...new Set(events.map((e) => e.assistantRecordId).filter((n): n is number => Number.isInteger(n as number)))];
                const titles = ids.length
                    ? new Map((await db.select({ id: assistantRecords.id, title: assistantRecords.title }).from(assistantRecords)
                        .where(and(eq(assistantRecords.organisationId, orgId), inArray(assistantRecords.id, ids)))).map((t) => [t.id, t.title]))
                    : new Map<number, string>();
                for (const e of events) {
                    const pj = describeLeadEvent(e, e.assistantRecordId != null ? titles.get(e.assistantRecordId) ?? null : null);
                    if (pj) items.push({ id: `rev-${e.id}`, type: e.eventType, icon: pj.icon, description: pj.description, createdAt: e.occurredAt, status: pj.status });
                }
            } else {
                items.push(...await roleActivityItems(db, { orgId, assistantId: a.id, roleKey: a.roleKey, cutoff, limit: PER_ASSISTANT }));
            }
            items.sort((x, y) => new Date(y.createdAt).getTime() - new Date(x.createdAt).getTime());
            for (const it of items.slice(0, PER_ASSISTANT)) out.push({ ...it, assistantId: a.id, assistantName: a.name });
        } catch (err) {
            // One assistant's source failing must not empty the widget for the others.
            console.error('[dashboard-recent-work] assistant skipped', a.id, err);
        }
    }));

    out.sort((x, y) => new Date(y.createdAt).getTime() - new Date(x.createdAt).getTime());
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: out.slice(0, MAX_ITEMS) }) };
});
