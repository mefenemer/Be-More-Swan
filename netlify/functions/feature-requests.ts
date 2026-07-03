// netlify/functions/feature-requests.ts
// Feature Requests & Roadmap — user-facing API (US01–US03).
//
// GET   /feature-requests                                  → public board (approved statuses)
//          ?search=&category=&status=&sort=popular|newest
// GET   /feature-requests?action=search&q=                 → live duplicate search while typing (US01)
// GET   /feature-requests?action=mine                      → the caller's own submissions (incl. pending_review)
// GET   /feature-requests?action=roadmap                   → read-only roadmap grouped Year → Quarter (US03)
// GET   /feature-requests?action=metrics                   → avg request→release wait time (US03)
// GET   /feature-requests?action=catalogue                 → assistant catalogue for the dependent dropdown (US01)
// POST  /feature-requests  { title, description, category, assistantRef? }
//                                                          → submit a request (defaults to pending_review) (US01)
// POST  /feature-requests?action=vote { featureId }        → toggle an upvote (US02)
//
// The board is GLOBAL / cross-tenant: every workspace user sees the same approved requests and votes.
// Submissions land as 'pending_review' — visible only to the submitter (here) and Admins (admin fn),
// protecting IP and filtering spam before anything goes public.

import { Handler } from '@netlify/functions';
import { and, desc, asc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { featureRequests, featureRequestVotes, masterAssistants } from '../../db/schema';
import { requireSession } from '../../src/utils/session';
import { resolveActiveOrg } from '../../src/utils/tenant';
import {
    FR_CATEGORY_LABEL,
    FR_STATUS_LABEL,
    PUBLIC_STATUSES,
    ROADMAP_STATUSES,
    isFeatureCategory,
    isQuarter,
    parseQuarter,
    quarterSortKey,
    syncVoteCount,
    votedFeatureIds,
} from '../../src/utils/feature-requests';

const json = (statusCode: number, body: unknown) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});

const PUBLIC = PUBLIC_STATUSES as unknown as string[];

// Shape a DB row into the board card payload.
function card(r: any, voted: Set<number>) {
    return {
        id: r.id,
        title: r.title,
        description: r.description,
        category: r.category,
        categoryLabel: FR_CATEGORY_LABEL[r.category as keyof typeof FR_CATEGORY_LABEL] || r.category,
        assistantRef: r.assistantRef,
        status: r.status,
        statusLabel: FR_STATUS_LABEL[r.status as keyof typeof FR_STATUS_LABEL] || r.status,
        targetQuarter: r.targetQuarter,
        voteCount: r.voteCount,
        hasVoted: voted.has(r.id),
        createdAt: r.createdAt,
    };
}

export const handler: Handler = async (event) => {
    const db = getDb();

    const session = requireSession(event);
    if ('error' in session) return session.error;
    const userId = session.userId;

    const qp = event.queryStringParameters || {};
    const action = qp.action || '';

    // ── GET ─────────────────────────────────────────────────────────────────────
    if (event.httpMethod === 'GET') {
        // Assistant catalogue for the "Existing Assistant" dependent dropdown.
        if (action === 'catalogue') {
            const rows = await db
                .select({ roleKey: masterAssistants.roleKey, name: masterAssistants.name })
                .from(masterAssistants)
                .orderBy(asc(masterAssistants.name));
            return json(200, { assistants: rows });
        }

        // Live duplicate search while typing a new request (title/description match, public only).
        if (action === 'search') {
            const q = (qp.q || '').trim();
            if (q.length < 2) return json(200, { matches: [] });
            const like = `%${q}%`;
            const rows = await db
                .select({
                    id: featureRequests.id, title: featureRequests.title,
                    status: featureRequests.status, voteCount: featureRequests.voteCount,
                })
                .from(featureRequests)
                .where(and(
                    inArray(featureRequests.status, PUBLIC),
                    or(ilike(featureRequests.title, like), ilike(featureRequests.description, like)),
                ))
                .orderBy(desc(featureRequests.voteCount))
                .limit(5);
            return json(200, {
                matches: rows.map((r) => ({
                    id: r.id, title: r.title, voteCount: r.voteCount,
                    statusLabel: FR_STATUS_LABEL[r.status as keyof typeof FR_STATUS_LABEL] || r.status,
                })),
            });
        }

        // The caller's own submissions, including not-yet-public ones.
        if (action === 'mine') {
            const rows = await db
                .select()
                .from(featureRequests)
                .where(eq(featureRequests.submittedBy, userId))
                .orderBy(desc(featureRequests.createdAt))
                .limit(100);
            const voted = await votedFeatureIds(db, userId, rows.map((r) => r.id));
            return json(200, { requests: rows.map((r) => card(r, voted)) });
        }

        // Read-only roadmap (US03): only Planned / In Progress, grouped Year → Quarter.
        if (action === 'roadmap') {
            const rows = await db
                .select()
                .from(featureRequests)
                .where(and(
                    inArray(featureRequests.status, ROADMAP_STATUSES as unknown as string[]),
                    sql`${featureRequests.targetQuarter} is not null`,
                ))
                .orderBy(desc(featureRequests.voteCount));
            const voted = await votedFeatureIds(db, userId, rows.map((r) => r.id));

            // Group by year → quarter, chronologically.
            const byQuarter: Record<string, any[]> = {};
            for (const r of rows) {
                if (!r.targetQuarter) continue;
                (byQuarter[r.targetQuarter] ??= []).push(card(r, voted));
            }
            const groups = Object.keys(byQuarter)
                .sort((a, b) => quarterSortKey(a) - quarterSortKey(b))
                .map((quarter) => {
                    const p = parseQuarter(quarter);
                    return { quarter, year: p?.year ?? null, q: p?.quarter ?? null, items: byQuarter[quarter] };
                });
            return json(200, { groups });
        }

        // Avg request→release wait time (US03).
        if (action === 'metrics') {
            const [row] = await db
                .select({
                    avgDays: sql<number | null>`avg(extract(epoch from (${featureRequests.releasedAt} - ${featureRequests.createdAt})) / 86400)`,
                    released: sql<number>`count(*)::int`,
                })
                .from(featureRequests)
                .where(and(
                    eq(featureRequests.status, 'released'),
                    sql`${featureRequests.releasedAt} is not null`,
                ));
            const avgDays = row?.avgDays != null ? Math.round(Number(row.avgDays)) : null;
            return json(200, { avgWaitDays: avgDays, releasedCount: row?.released ?? 0 });
        }

        // Default: the public board, with search / filter / sort (US02).
        const search = (qp.search || '').trim();
        const category = qp.category || '';
        const statusFilter = qp.status || '';
        const sort = qp.sort || 'popular';

        const conds: any[] = [inArray(featureRequests.status, PUBLIC)];
        if (search.length >= 1) {
            const like = `%${search}%`;
            conds.push(or(ilike(featureRequests.title, like), ilike(featureRequests.description, like)));
        }
        if (isFeatureCategory(category)) conds.push(eq(featureRequests.category, category));
        if (statusFilter && PUBLIC.includes(statusFilter)) conds.push(eq(featureRequests.status, statusFilter));

        const orderBy = sort === 'newest'
            ? [desc(featureRequests.createdAt)]
            : [desc(featureRequests.voteCount), desc(featureRequests.createdAt)];

        const rows = await db
            .select()
            .from(featureRequests)
            .where(and(...conds))
            .orderBy(...orderBy)
            .limit(200);
        const voted = await votedFeatureIds(db, userId, rows.map((r) => r.id));
        return json(200, { requests: rows.map((r) => card(r, voted)) });
    }

    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    let body: any;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }

    // ── POST ?action=vote: toggle an upvote (US02) ───────────────────────────────
    if (action === 'vote') {
        const featureId = Number(body.featureId);
        if (!Number.isInteger(featureId)) return json(400, { error: 'featureId is required.' });

        // Only votable on public features.
        const [feature] = await db
            .select({ id: featureRequests.id, status: featureRequests.status })
            .from(featureRequests)
            .where(eq(featureRequests.id, featureId))
            .limit(1);
        if (!feature || !PUBLIC.includes(feature.status)) return json(404, { error: 'Feature not found.' });

        const [existing] = await db
            .select({ id: featureRequestVotes.id })
            .from(featureRequestVotes)
            .where(and(eq(featureRequestVotes.featureId, featureId), eq(featureRequestVotes.userId, userId)))
            .limit(1);

        let hasVoted: boolean;
        if (existing) {
            await db.delete(featureRequestVotes).where(eq(featureRequestVotes.id, existing.id));
            hasVoted = false;
        } else {
            // onConflictDoNothing guards the UNIQUE(feature,user) against double-submits.
            await db.insert(featureRequestVotes)
                .values({ featureId, userId })
                .onConflictDoNothing();
            hasVoted = true;
        }
        const voteCount = await syncVoteCount(db, featureId);
        return json(200, { ok: true, hasVoted, voteCount });
    }

    // ── POST (default): submit a new request (US01) ──────────────────────────────
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    const category = body.category;

    if (!title) return json(400, { error: 'A title is required.' });
    if (title.length > 200) return json(400, { error: 'Title is too long (200 char max).' });
    if (!description) return json(400, { error: 'A description is required.' });
    if (description.length > 5000) return json(400, { error: 'Description is too long (5000 char max).' });
    if (!isFeatureCategory(category)) return json(400, { error: 'Please choose a category.' });

    let assistantRef: string | null = null;
    if (category === 'existing_assistant') {
        const ref = typeof body.assistantRef === 'string' ? body.assistantRef.trim() : '';
        if (!ref) return json(400, { error: 'Please choose which assistant this is about.' });
        // Validate against the catalogue so assistant_ref is always a real role key.
        const [role] = await db
            .select({ roleKey: masterAssistants.roleKey })
            .from(masterAssistants)
            .where(eq(masterAssistants.roleKey, ref))
            .limit(1);
        if (!role) return json(400, { error: 'Unknown assistant.' });
        assistantRef = ref;
    }

    // Org is optional context — submission works regardless of org membership state.
    const org = await resolveActiveOrg(db, userId, session.activeOrganisationId);

    const [created] = await db.insert(featureRequests).values({
        submittedBy: userId,
        organisationId: org?.organisationId ?? null,
        title,
        description,
        submitterDescription: description, // preserve raw text for "Enhance with AI"
        category,
        assistantRef,
        status: 'pending_review',
        source: 'user',
    }).returning({ id: featureRequests.id });

    return json(201, { ok: true, id: created.id });
};
