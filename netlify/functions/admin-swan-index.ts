// netlify/functions/admin-swan-index.ts
// The Swan Index — editorial desk. The tool that turns a queue of submissions into a publication.
//
// GET    ?resource=overview                → status counts + section list, for the header cards
// GET    ?resource=queue[&status=]         → submissions; defaults to everything but 'withdrawn'
// GET    ?resource=post&id=N[&recheck=1]   → one piece in full, INCLUDING the rendered body and
//                                            the editorial safety screen (run on first open)
// GET    ?resource=featured                → the front page, in editorial order
// GET    ?resource=contributors            → profiles with their live/pending counts
// PATCH  ?resource=post&id=N               → { status?, section?, editorScore?, editorNote?, dek? }
// POST   ?resource=move&id=N               → { direction: 'up' | 'down' } — reorder the front page
// PATCH  ?resource=profile&id=N            → { status?, frontPageTier?, monthlyPostCap?, ... }
//
// Gated on `curate_swan_index` (platform_admin and above). Every mutation writes an admin_audit_log
// row: these are decisions about what appears on a public masthead under a CUSTOMER's byline, and
// "an editor rejected it" is only an answer to the author if we can say which editor and why.
//
// Deliberately its own function rather than another resource inside admin-api.ts — that file is
// already 20+ resources deep, and this one needs the swan-index modules nothing else imports.
//
// No paging. A magazine queue is tens of items, not thousands, and the header cards count the WHOLE
// set — a server LIMIT would quietly redefine "12 awaiting review" as "12 on this page". Capped at
// HARD_CAP with an explicit `truncated` flag so the day that assumption breaks, it says so.

import jwt from 'jsonwebtoken';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import {
    users, blogPosts, swanIndexPosts, swanIndexProfiles, swanIndexSections,
} from '../../db/schema';
import { hasPermission } from '../../src/utils/rbac';
import { insertAdminAuditLog, getAdminIp } from '../../src/utils/admin-audit';
import {
    canTransition, isCurationStatus, transitionPatch, resequenceFeatured, moveFeatured,
    parseEditorScore, parseMonthlyCap, normaliseNote, countByStatus, queueFilter,
    type CurationStatus,
} from '../../src/utils/swan-index/curation';
import { articlePath } from '../../src/utils/swan-index/render';
import { swanIndexBaseUrl } from '../../src/utils/swan-index/base-url';
import { resolveInlineMedia, resolveFeatureImageUrl } from '../../src/utils/blog-media-resolve';
import { isAiAssisted } from '../../src/utils/blog-ai-assisted';
import { runSafetyScreen, readSafetyReport, summariseSafety } from '../../src/utils/swan-index/safety';
import { monthlyPostCount } from '../../src/utils/swan-index/profile';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;
const HARD_CAP = 200;

const json = (statusCode: number, body: unknown) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});

async function requireEditor(event: any): Promise<{ id: number; role: string } | null> {
    if (!jwtSecret) return null;
    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return null;
    let userId: number;
    try { userId = (jwt.verify(match[1], jwtSecret) as { userId: number }).userId; } catch { return null; }
    const db = getDb();
    const [row] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
    if (!hasPermission(row?.role, 'curate_swan_index')) return null;
    return { id: userId, role: row.role };
}

/** The row shape every list surface renders. */
const LIST_COLUMNS = {
    id: swanIndexPosts.id,
    blogPostId: swanIndexPosts.blogPostId,
    title: swanIndexPosts.title,
    dek: swanIndexPosts.dek,
    slug: swanIndexPosts.slug,
    status: swanIndexPosts.status,
    section: swanIndexPosts.section,
    sectionLabel: swanIndexSections.label,
    featuredRank: swanIndexPosts.featuredRank,
    editorScore: swanIndexPosts.editorScore,
    editorNote: swanIndexPosts.editorNote,
    robots: swanIndexPosts.robots,
    tags: swanIndexPosts.tags,
    authorCanonicalUrl: swanIndexPosts.authorCanonicalUrl,
    submittedAt: swanIndexPosts.submittedAt,
    liveAt: swanIndexPosts.liveAt,
    updatedAt: swanIndexPosts.updatedAt,
    readCount: swanIndexPosts.readCount,
    safetyCheck: swanIndexPosts.safetyCheck,
    safetyCheckedAt: swanIndexPosts.safetyCheckedAt,
    profileId: swanIndexPosts.profileId,
    handle: swanIndexProfiles.handle,
    displayName: swanIndexProfiles.displayName,
    profileStatus: swanIndexProfiles.status,
    monthlyPostCap: swanIndexProfiles.monthlyPostCap,
    frontPageTier: swanIndexProfiles.frontPageTier,
    // Read live, so a piece whose source post was unpublished is visible AS SUCH in the queue
    // rather than looking healthy right up until an editor features a page that 404s.
    sourceStatus: blogPosts.status,
};

function listQuery(db: ReturnType<typeof getDb>) {
    return db
        .select(LIST_COLUMNS)
        .from(swanIndexPosts)
        .innerJoin(swanIndexProfiles, eq(swanIndexProfiles.id, swanIndexPosts.profileId))
        .innerJoin(blogPosts, eq(blogPosts.id, swanIndexPosts.blogPostId))
        .leftJoin(swanIndexSections, eq(swanIndexSections.key, swanIndexPosts.section));
}

export default withLambda(async (event) => {
    const admin = await requireEditor(event);
    if (!admin) return json(403, { error: 'Access denied. Editorial access to The Swan Index is required.' });

    const db = getDb();
    const qs = event.queryStringParameters || {};
    const resource = qs.resource || '';
    const id = qs.id ? Number(qs.id) : null;
    const baseUrl = swanIndexBaseUrl();

    // ── GET ?resource=overview ─────────────────────────────────────────────────────────────────
    if (event.httpMethod === 'GET' && resource === 'overview') {
        const [counts, sections, contributors] = await Promise.all([
            countByStatus(db),
            db.select({
                key: swanIndexSections.key,
                label: swanIndexSections.label,
                standfirst: swanIndexSections.standfirst,
                active: swanIndexSections.active,
            }).from(swanIndexSections).orderBy(swanIndexSections.position),
            db.select({ n: sql<number>`count(*)::int` }).from(swanIndexProfiles).where(eq(swanIndexProfiles.status, 'active')),
        ]);
        return json(200, { counts, sections, contributors: contributors[0]?.n ?? 0, baseUrl });
    }

    // ── GET ?resource=queue[&status=] ──────────────────────────────────────────────────────────
    if (event.httpMethod === 'GET' && resource === 'queue') {
        const rows = await listQuery(db)
            .where(queueFilter(qs.status))
            // Oldest submission first: a queue is worked front to back, and the piece that has been
            // waiting longest is the one an author is most likely to have given up on.
            .orderBy(swanIndexPosts.submittedAt)
            .limit(HARD_CAP + 1);
        return json(200, {
            items: rows.slice(0, HARD_CAP),
            truncated: rows.length > HARD_CAP,
            baseUrl,
        });
    }

    // ── GET ?resource=featured ─────────────────────────────────────────────────────────────────
    if (event.httpMethod === 'GET' && resource === 'featured') {
        const rows = await listQuery(db)
            .where(eq(swanIndexPosts.status, 'featured'))
            .orderBy(swanIndexPosts.featuredRank);
        // Everything that COULD be promoted, so the editor can fill the page without leaving it.
        const eligible = await listQuery(db)
            .where(eq(swanIndexPosts.status, 'live'))
            .orderBy(desc(swanIndexPosts.liveAt))
            .limit(50);
        return json(200, { items: rows, eligible, baseUrl });
    }

    // ── GET ?resource=contributors ─────────────────────────────────────────────────────────────
    if (event.httpMethod === 'GET' && resource === 'contributors') {
        const rows = await db
            .select({
                id: swanIndexProfiles.id,
                organisationId: swanIndexProfiles.organisationId,
                handle: swanIndexProfiles.handle,
                displayName: swanIndexProfiles.displayName,
                roleTitle: swanIndexProfiles.roleTitle,
                companyName: swanIndexProfiles.companyName,
                siteUrl: swanIndexProfiles.siteUrl,
                bio: swanIndexProfiles.bio,
                status: swanIndexProfiles.status,
                frontPageTier: swanIndexProfiles.frontPageTier,
                monthlyPostCap: swanIndexProfiles.monthlyPostCap,
                createdAt: swanIndexProfiles.createdAt,
                // LEFT join + FILTER, not a WHERE: a profile with nothing published yet is exactly
                // the one an editor wants to see, and an inner join would hide it.
                livePieces: sql<number>`count(*) filter (where ${swanIndexPosts.status} in ('live','featured'))::int`,
                pendingPieces: sql<number>`count(*) filter (where ${swanIndexPosts.status} = 'pending')::int`,
                rejectedPieces: sql<number>`count(*) filter (where ${swanIndexPosts.status} = 'rejected')::int`,
                thisMonth: sql<number>`count(*) filter (where ${swanIndexPosts.status} in ('pending','live','featured') and ${swanIndexPosts.submittedAt} >= date_trunc('month', now()))::int`,
            })
            .from(swanIndexProfiles)
            .leftJoin(swanIndexPosts, eq(swanIndexPosts.profileId, swanIndexProfiles.id))
            .groupBy(swanIndexProfiles.id)
            .orderBy(desc(sql`count(*) filter (where ${swanIndexPosts.status} in ('live','featured'))`));
        return json(200, { items: rows, baseUrl });
    }

    // ── GET ?resource=post&id=N ────────────────────────────────────────────────────────────────
    // The reading view. A pending piece is not public — by design — so this is the ONLY way an
    // editor can read one before deciding on it. Without it the queue would be a list of headlines
    // to judge blind, which is not curation.
    if (event.httpMethod === 'GET' && resource === 'post') {
        if (!Number.isFinite(id)) return json(400, { error: 'id is required.' });
        const [row] = await listQuery(db).where(eq(swanIndexPosts.id, id!)).limit(1);
        if (!row) return json(404, { error: 'Not found.' });

        const [source] = await db
            .select({
                organisationId: blogPosts.organisationId,
                publishedPayload: blogPosts.publishedPayload,
                metaDescription: blogPosts.metaDescription,
                jobId: blogPosts.jobId,
                blueprintId: blogPosts.blueprintId,
                isAutonomous: blogPosts.isAutonomous,
                generationReason: blogPosts.generationReason,
                confidenceScore: blogPosts.confidenceScore,
            })
            .from(blogPosts)
            .where(eq(blogPosts.id, row.blogPostId))
            .limit(1);

        const payload = (source?.publishedPayload as Record<string, any> | null) || null;
        let bodyHtml: string = (payload && typeof payload.html === 'string') ? payload.html : '';
        if (bodyHtml && source) bodyHtml = await resolveInlineMedia(db, source.organisationId, bodyHtml);
        const imageUrl = source ? await resolveFeatureImageUrl(db, source.organisationId, payload?.featureImage?.assetId) : null;

        const aiAssisted = source ? isAiAssisted(source) : false;

        // ── the editorial safety screen ────────────────────────────────────────────────────────
        // Run on the FIRST open and re-run when the submission has been touched since (a re-publish
        // bumps updated_at), so an editor never reads a verdict about an older version of the piece.
        // ?recheck=1 forces it. A stored report from an earlier check LIST is treated as absent —
        // readSafetyReport() gates on the version — because "5/5 confirmed" against yesterday's five
        // checks is the false green this whole feature exists to prevent.
        let safety = readSafetyReport(row.safetyCheck);
        const stale = !row.safetyCheckedAt || (row.updatedAt && row.safetyCheckedAt < row.updatedAt);
        if (!safety || stale || qs.recheck === '1') {
            safety = await runSafetyScreen({
                title: row.title,
                dek: row.dek,
                bodyHtml,
                featureImageUrl: imageUrl,
                featureImageAlt: (payload?.featureImage?.alt as string | undefined) ?? null,
                authorCanonicalUrl: row.authorCanonicalUrl,
                publicationOrigin: baseUrl,
                aiAssisted,
                profileStatus: row.profileStatus,
                monthlyPostCap: row.monthlyPostCap,
                monthlyPostCount: await monthlyPostCount(db, row.profileId),
            });
            // Best-effort: a failed write costs a re-run on the next open, never the drawer.
            await db.update(swanIndexPosts)
                .set({ safetyCheck: safety, safetyCheckedAt: new Date() })
                .where(eq(swanIndexPosts.id, id!))
                .catch((err) => console.error('[swan-index] could not store the safety report:', err));
        }

        return json(200, {
            post: row,
            bodyHtml,
            imageUrl,
            // Surfaced because it decides whether the AI notice appears on the published page, and
            // an editor should know they are reading a machine-drafted piece before featuring it.
            aiAssisted,
            confidenceScore: source?.confidenceScore ?? null,
            safety,
            safetySummary: summariseSafety(safety),
            publicUrl: `${baseUrl}${articlePath(row.handle, row.slug)}`,
        });
    }

    // ── PATCH ?resource=post&id=N ──────────────────────────────────────────────────────────────
    if (event.httpMethod === 'PATCH' && resource === 'post') {
        if (!Number.isFinite(id)) return json(400, { error: 'id is required.' });
        let body: Record<string, unknown>;
        try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }

        const [current] = await db
            .select({
                id: swanIndexPosts.id,
                status: swanIndexPosts.status,
                section: swanIndexPosts.section,
                liveAt: swanIndexPosts.liveAt,
                featuredAt: swanIndexPosts.featuredAt,
                editorScore: swanIndexPosts.editorScore,
                editorNote: swanIndexPosts.editorNote,
                robots: swanIndexPosts.robots,
                title: swanIndexPosts.title,
                blogPostId: swanIndexPosts.blogPostId,
                safetyCheck: swanIndexPosts.safetyCheck,
            })
            .from(swanIndexPosts)
            .where(eq(swanIndexPosts.id, id!))
            .limit(1);
        if (!current) return json(404, { error: 'Not found.' });

        const patch: Record<string, unknown> = { updatedAt: new Date() };

        // ── status ──
        let statusChanged = false;
        if (body.status !== undefined) {
            if (!isCurationStatus(body.status)) return json(400, { error: 'Unknown status.' });
            const check = canTransition(current.status as CurationStatus, body.status);
            if (!check.ok) return json(422, { error: check.error });

            // Going public means the SOURCE post must still be published. Without this an editor can
            // feature a piece whose author unpublished it, and the front page links to a 404 —
            // getArticle() filters on blog_posts.status, so the card would render and the page
            // behind it would not.
            if ((body.status === 'live' || body.status === 'featured')) {
                const [src] = await db.select({ status: blogPosts.status })
                    .from(blogPosts).where(eq(blogPosts.id, current.blogPostId)).limit(1);
                if (src?.status !== 'published') {
                    return json(422, {
                        error: `The author's post is ${src?.status ?? 'missing'}, not published, so this piece has no page to link to.`,
                    });
                }
            }
            Object.assign(patch, transitionPatch(body.status, current));
            statusChanged = body.status !== current.status;
        }

        // ── section ──
        if (body.section !== undefined) {
            const key = body.section === null || body.section === '' ? null : String(body.section);
            if (key) {
                const [sec] = await db.select({ key: swanIndexSections.key })
                    .from(swanIndexSections).where(and(eq(swanIndexSections.key, key), eq(swanIndexSections.active, true))).limit(1);
                if (!sec) return json(400, { error: 'Unknown section.' });
            }
            patch.section = key;
        }

        // ── editorial metadata ──
        if (body.editorScore !== undefined) {
            const parsed = parseEditorScore(body.editorScore);
            if (!parsed.ok) return json(400, { error: parsed.error });
            patch.editorScore = parsed.value;
        }
        if (body.editorNote !== undefined) patch.editorNote = normaliseNote(body.editorNote);
        // The dek is the standfirst under the headline. Editable because it is generated from the
        // post's meta description, which is written for search engines and often reads like one.
        if (body.dek !== undefined) patch.dek = normaliseNote(body.dek, 300);

        if (Object.keys(patch).length === 1) return json(400, { error: 'Nothing to change.' });

        await db.update(swanIndexPosts).set(patch).where(eq(swanIndexPosts.id, id!));

        // Ranks are only ever gapless immediately after this runs — see resequenceFeatured.
        if (statusChanged) await resequenceFeatured(db);

        void insertAdminAuditLog({
            adminId: admin.id,
            action: 'swan_index_curation',
            targetType: 'swan_index_post',
            targetId: id!,
            previousState: { status: current.status, section: current.section, robots: current.robots, editorScore: current.editorScore },
            newState: { status: patch.status ?? current.status, section: patch.section ?? current.section, robots: patch.robots ?? current.robots, editorScore: patch.editorScore ?? current.editorScore },
            reason: normaliseNote(body.editorNote) ?? undefined,
            ipAddress: getAdminIp(event.headers as Record<string, string | undefined>),
            // The safety verdict AS IT STOOD when the decision was made. An approval is a decision
            // about someone else's content on our domain, and "what did the screen say at the time"
            // is the first question anyone asks afterwards — including when it said nothing.
            metadata: { title: current.title, safety: summariseSafety(readSafetyReport(current.safetyCheck)) },
        });

        const [updated] = await listQuery(db).where(eq(swanIndexPosts.id, id!)).limit(1);
        return json(200, { post: updated });
    }

    // ── POST ?resource=move&id=N ───────────────────────────────────────────────────────────────
    if (event.httpMethod === 'POST' && resource === 'move') {
        if (!Number.isFinite(id)) return json(400, { error: 'id is required.' });
        let body: { direction?: string };
        try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }
        if (body.direction !== 'up' && body.direction !== 'down') {
            return json(400, { error: "direction must be 'up' or 'down'." });
        }
        const moved = await moveFeatured(db, id!, body.direction);
        if (!moved) return json(409, { error: 'That piece is already at the end of the running order.' });

        void insertAdminAuditLog({
            adminId: admin.id,
            action: 'swan_index_curation',
            targetType: 'swan_index_post',
            targetId: id!,
            newState: { moved: body.direction },
            ipAddress: getAdminIp(event.headers as Record<string, string | undefined>),
        });

        const items = await listQuery(db).where(eq(swanIndexPosts.status, 'featured')).orderBy(swanIndexPosts.featuredRank);
        return json(200, { items });
    }

    // ── PATCH ?resource=profile&id=N ───────────────────────────────────────────────────────────
    if (event.httpMethod === 'PATCH' && resource === 'profile') {
        if (!Number.isFinite(id)) return json(400, { error: 'id is required.' });
        let body: Record<string, unknown>;
        try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }

        const [current] = await db
            .select({
                id: swanIndexProfiles.id,
                handle: swanIndexProfiles.handle,
                status: swanIndexProfiles.status,
                frontPageTier: swanIndexProfiles.frontPageTier,
                monthlyPostCap: swanIndexProfiles.monthlyPostCap,
            })
            .from(swanIndexProfiles)
            .where(eq(swanIndexProfiles.id, id!))
            .limit(1);
        if (!current) return json(404, { error: 'Not found.' });

        const patch: Record<string, unknown> = { updatedAt: new Date() };

        if (body.status !== undefined) {
            // 'withdrawn' is the AUTHOR's state, set by disconnecting the destination. An editor
            // suspends; only the author withdraws, and reinstating them here would reconnect a
            // destination they chose to leave.
            if (body.status !== 'active' && body.status !== 'suspended') {
                return json(400, { error: "Profile status must be 'active' or 'suspended'." });
            }
            if (current.status === 'withdrawn') {
                return json(422, { error: 'This contributor disconnected The Swan Index themselves. They reinstate it from Blog Studio.' });
            }
            patch.status = body.status;
        }
        if (body.frontPageTier !== undefined) patch.frontPageTier = !!body.frontPageTier;
        if (body.monthlyPostCap !== undefined) {
            const parsed = parseMonthlyCap(body.monthlyPostCap);
            if (!parsed.ok) return json(400, { error: parsed.error });
            patch.monthlyPostCap = parsed.value;
        }

        if (Object.keys(patch).length === 1) return json(400, { error: 'Nothing to change.' });

        await db.update(swanIndexProfiles).set(patch).where(eq(swanIndexProfiles.id, id!));

        // Suspending a contributor takes their whole back catalogue off the site — the public
        // queries already filter on profile status, so nothing here has to touch their posts. Said
        // out loud because it is a big consequence for a small-looking control, and the UI warns.
        void insertAdminAuditLog({
            adminId: admin.id,
            action: 'swan_index_profile_change',
            targetType: 'swan_index_profile',
            targetId: id!,
            previousState: { status: current.status, frontPageTier: current.frontPageTier, monthlyPostCap: current.monthlyPostCap },
            newState: { status: patch.status ?? current.status, frontPageTier: patch.frontPageTier ?? current.frontPageTier, monthlyPostCap: patch.monthlyPostCap ?? current.monthlyPostCap },
            ipAddress: getAdminIp(event.headers as Record<string, string | undefined>),
            metadata: { handle: current.handle },
        });

        return json(200, { ok: true });
    }

    return json(400, { error: 'Unknown resource.' });
});
