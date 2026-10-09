// netlify/functions/brand-briefs.ts
// The Brand Designer's API — the ONE server path both surfaces use: the Briefs tab
// (src/components/assistant-briefs.js) and the chat cards (disruptive-ui-registry.js → chat-session.js).
// docs/brand-designer-plan.md §4.6: anything the tab can do, the chat can ask for — and only a
// human click on either surface creates, spends or approves.
//
// POST { action, … }
//   list     { assistantId }                      → briefs + options, vocabulary, credits; ends stuck rounds
//   create   { assistantId, …brief, generate? }   → a brief; generate:true also starts round 1
//   edit     { briefId, …brief }                  → change a brief between rounds
//   generate { briefId }                          → one round of options (holds the AI credit)
//   decide   { optionId, decision, reason?, note? } → approve into the library / reject with a reason
//   cancel   { briefId }
//   add_own  { briefId, contentAssetIds }           → the user's own pictures as options (Phase 4): an
//                                                     upload (made a library asset first, through My
//                                                     Content's own upload + safety check) or a library
//                                                     picture — which is where a Canva import lands
//   list_library {}                                 → the library, for that picker
//   calendar     { assistantId, from, to }          → brief due dates, for the Calendar tab
//   post_brief   { postId }                         → is there a Brand Designer, and a brief for this post? (Phase 5)
//   brief_for_post { postId, context? }             → "Ask the Brand Designer" from the post editor

import { and, eq, sql } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { aiAssistants, scheduledPosts, visualBriefs } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { enforcePromptModeration } from '../../src/utils/moderation';
import { getBalance } from '../../src/utils/ai-credits';
import { orgHasAssistantFeature } from '../../src/utils/assistant-capabilities';
import { BRAND_DESIGNER_ROLE_KEY } from '../../src/constants/roles';
import { briefVocabForClient, normaliseBrief } from '../../src/config/visual-brief-vocab';
import {
    addOwnOptions, cancelBrief, decideOption, defaultSourcesFor, endRound, listBriefs, listLibraryForPicker, startRound,
    raiseBriefForPost, sweepStuckRounds, videoUnavailableReason, type BriefRow,
} from '../../src/utils/visual-briefs';
import { readBrandGuidelines } from '../../src/utils/brand-guidelines';
import { triggerBriefRound } from '../../src/utils/trigger-brief-round';

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

/** The words a round is made from — moderated before a credit is held or a provider is called. */
function briefText(b: Pick<BriefRow, 'title' | 'message' | 'headline' | 'mood' | 'mustInclude'>): string {
    return [b.title, b.message, b.headline, b.mood, b.mustInclude].filter(Boolean).join('\n');
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId, userId } = ctx;

    let body: Record<string, unknown>;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
    const action = String(body.action || '');

    /** IDOR + role guard: only THIS organisation's Brand Designer may own briefs. */
    async function requireDesigner(raw: unknown) {
        const id = Number(raw);
        if (!Number.isInteger(id) || id <= 0) return null;
        const [a] = await db.select({ id: aiAssistants.id, onboardingContext: aiAssistants.onboardingContext }).from(aiAssistants).where(and(
            eq(aiAssistants.id, id),
            eq(aiAssistants.organisationId, orgId),
            sql`(${aiAssistants.configuration} ->> 'type') = ${BRAND_DESIGNER_ROLE_KEY}`,
        )).limit(1);
        return a ?? null;
    }

    async function requireBrief(raw: unknown) {
        const id = Number(raw);
        if (!Number.isInteger(id) || id <= 0) return null;
        const [b] = await db.select().from(visualBriefs)
            .where(and(eq(visualBriefs.id, id), eq(visualBriefs.organisationId, orgId))).limit(1);
        return b ?? null;
    }

    /**
     * Start a round and wake the worker. A dispatch that fails ends the round at once and refunds it —
     * the user is told now, not after a ten-minute "Making options…".
     */
    async function generate(brief: BriefRow) {
        const blocked = await enforcePromptModeration({ text: briefText(brief), userId, organisationId: orgId, source: 'brand-briefs' });
        if (blocked) return blocked;
        const started = await startRound(db, { orgId, brief });
        if (!started.ok) {
            const { status, ...rest } = started;
            return json(status, rest);
        }
        if (!(await triggerBriefRound(brief.id, userId))) {
            await endRound(db, brief.id, { chargeAi: false, note: 'Could not start making options. Nothing was charged — try again.' });
            return json(503, { error: 'Could not start making options. Nothing was charged — please try again.' });
        }
        return json(202, { ok: true, briefId: brief.id, round: started.round, aiIncluded: started.aiIncluded, credits: started.credits });
    }

    if (action === 'list') {
        const designer = await requireDesigner(body.assistantId);
        if (!designer) return json(404, { error: 'Assistant not found.' });
        await sweepStuckRounds(db, orgId);
        const [briefs, balance, aiAvailable, guidelines, videoBlocked] = await Promise.all([
            listBriefs(db, orgId, designer.id),
            getBalance(db, orgId).catch(() => null),
            orgHasAssistantFeature(db, orgId, 'ai_image_generation').catch(() => false),
            readBrandGuidelines(db, orgId).catch(() => null),
            videoUnavailableReason(db, orgId).catch(() => 'AI video could not be checked just now.'),
        ]);
        return json(200, {
            briefs,
            vocab: briefVocabForClient(),
            credits: balance ? balance.balance : null,
            aiAvailable,
            // Null when AI video can be made here; otherwise WHY not, in words (feature or plan) —
            // the form shows it beside the greyed-out tick box rather than a bare "unavailable".
            aiVideoUnavailable: videoBlocked,
            // What "New brief" ticks by default — from setup, so a "free only" business is never
            // one unnoticed tick away from spending a credit.
            defaultSources: defaultSourcesFor(designer.onboardingContext),
            // The workspace's picture guidelines — shown on the tab so the user can see what every
            // round is told. null = could not be read (said as such), not "none set".
            guidelines,
        });
    }

    // The four Overview cards (metricsSource 'brand' in the dashboard registry). All time — a brief
    // is a one-off job, not a stream with a natural 30-day window. `hitRate` is null until something
    // has been decided: "0%" would claim every option was turned down.
    if (action === 'performance') {
        const designer = await requireDesigner(body.assistantId);
        if (!designer) return json(404, { error: 'Assistant not found.' });
        const [counts] = await db.execute<{ approved: number; rejected: number; waiting: number; briefs: number }>(sql`
            SELECT count(*) FILTER (WHERE o.status = 'approved')::int AS approved,
                   count(*) FILTER (WHERE o.status = 'rejected' AND coalesce(o.reject_reason, '') NOT LIKE 'other: brief cancelled%')::int AS rejected,
                   (SELECT count(*)::int FROM visual_briefs b2
                     WHERE b2.ai_assistant_id = ${designer.id} AND b2.organisation_id = ${orgId} AND b2.status <> 'cancelled'
                       AND EXISTS (SELECT 1 FROM visual_brief_options o2 WHERE o2.brief_id = b2.id AND o2.status = 'proposed')) AS waiting,
                   (SELECT count(*)::int FROM visual_briefs b3 WHERE b3.ai_assistant_id = ${designer.id} AND b3.organisation_id = ${orgId}) AS briefs
              FROM visual_brief_options o
              JOIN visual_briefs b ON b.id = o.brief_id
             WHERE b.ai_assistant_id = ${designer.id} AND b.organisation_id = ${orgId}`);
        // Credits are read from the generation jobs this assistant ran, completed only — a failed or
        // refused round was refunded and cost nothing.
        const [spent] = await db.execute<{ credits: number }>(sql`
            SELECT coalesce(sum(credit_cost), 0)::int AS credits FROM media_generation_jobs
             WHERE organisation_id = ${orgId} AND assistant_id = ${designer.id} AND status = 'completed'`);
        const approved = Number(counts?.approved ?? 0);
        const rejected = Number(counts?.rejected ?? 0);
        return json(200, {
            hasData: Number(counts?.briefs ?? 0) > 0,
            metrics: {
                approved,
                waiting: Number(counts?.waiting ?? 0),
                hitRate: approved + rejected > 0 ? approved / (approved + rejected) : null,
                creditsSpent: Number(spent?.credits ?? 0),
            },
        });
    }

    // The Calendar tab: briefs on their due date. Cancelled briefs are left off; an approved one stays
    // (it shows the deadline was met). Light on purpose — no options, no signed URLs.
    if (action === 'calendar') {
        const designer = await requireDesigner(body.assistantId);
        if (!designer) return json(404, { error: 'Assistant not found.' });
        const from = typeof body.from === 'string' ? body.from.slice(0, 10) : null;
        const to = typeof body.to === 'string' ? body.to.slice(0, 10) : null;
        const rows = await db.select({ id: visualBriefs.id, title: visualBriefs.title, status: visualBriefs.status, dueDate: visualBriefs.dueDate })
            .from(visualBriefs).where(and(
                eq(visualBriefs.organisationId, orgId), eq(visualBriefs.aiAssistantId, designer.id),
                sql`${visualBriefs.dueDate} IS NOT NULL`, sql`${visualBriefs.status} <> 'cancelled'`,
                ...(from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? [sql`${visualBriefs.dueDate} >= ${from}`] : []),
                ...(to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? [sql`${visualBriefs.dueDate} <= ${to}`] : []),
            )).limit(500);
        return json(200, { items: rows.map((b) => ({ id: b.id, title: b.title, status: b.status, dueDate: String(b.dueDate) })) });
    }

    if (action === 'create') {
        const designer = await requireDesigner(body.assistantId);
        if (!designer) return json(404, { error: 'Assistant not found.' });
        const n = normaliseBrief(body);
        if (!n.ok) return json(400, { error: n.error });
        const [brief] = await db.insert(visualBriefs).values({
            organisationId: orgId, aiAssistantId: designer.id, createdBy: userId,
            ...n.brief,
            origin: body.origin === 'chat' ? 'chat' : 'user',
        }).returning();
        if (body.generate !== true) return json(201, { ok: true, briefId: brief.id });
        const res = await generate(brief);
        // The brief exists whatever happened to its first round, so this is a 201 either way, with
        // the round's refusal alongside (`roundError`, in the same shape as a failed `generate`).
        // An error STATUS here would read to every caller as "nothing was created", and the next
        // press of Save would make a second copy of the brief.
        const parsed = JSON.parse(res.body || '{}');
        return res.statusCode === 202
            ? json(201, { ...parsed, ok: true, briefId: brief.id, roundStarted: true })
            : json(201, { ok: true, briefId: brief.id, roundStarted: false, roundError: parsed });
    }

    if (action === 'edit') {
        const brief = await requireBrief(body.briefId);
        if (!brief) return json(404, { error: 'Brief not found.' });
        if (brief.status === 'generating') return json(409, { error: 'Options are being made right now — edit the brief when they arrive.' });
        if (brief.status === 'cancelled') return json(409, { error: 'This brief was cancelled.' });
        // Merge over the stored brief, then normalise the whole thing: an edit cannot produce a brief
        // that create would have refused.
        const merged = {
            title: brief.title, purpose: brief.purpose, aspectRatio: brief.aspectRatio, message: brief.message,
            headline: brief.headline, mood: brief.mood, mustInclude: brief.mustInclude, mustAvoid: brief.mustAvoid,
            sources: brief.sources, dueDate: brief.dueDate, waitingOn: brief.waitingOn,
            ...Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'action' && k !== 'briefId')),
        };
        const n = normaliseBrief(merged);
        if (!n.ok) return json(400, { error: n.error });
        await db.update(visualBriefs).set({ ...n.brief, updatedAt: new Date() })
            .where(and(eq(visualBriefs.id, brief.id), eq(visualBriefs.organisationId, orgId)));
        return json(200, { ok: true });
    }

    if (action === 'generate') {
        const brief = await requireBrief(body.briefId);
        if (!brief) return json(404, { error: 'Brief not found.' });
        return generate(brief);
    }

    if (action === 'decide') {
        const optionId = Number(body.optionId);
        const decision = body.decision === 'approve' ? 'approve' : body.decision === 'reject' ? 'reject' : null;
        if (!Number.isInteger(optionId) || optionId <= 0 || !decision) return json(400, { error: 'optionId and decision (approve|reject) are required.' });
        const r = await decideOption(db, {
            orgId, userId, optionId, decision,
            reason: typeof body.reason === 'string' ? body.reason : null,
            note: typeof body.note === 'string' ? body.note : null,
        });
        if (!r.ok) return json(r.status, { error: r.error });
        return json(200, r);
    }

    if (action === 'add_own') {
        const ids = Array.isArray(body.contentAssetIds) ? body.contentAssetIds.map(Number) : [];
        const r = await addOwnOptions(db, { orgId, briefId: Number(body.briefId), contentAssetIds: ids });
        if (!r.ok) return json(r.status, { error: r.error });
        return json(200, r);
    }

    if (action === 'list_library') {
        return json(200, { assets: await listLibraryForPicker(db, orgId) });
    }

    // Phase 5 — the post editor. `designerId` null = no Brand Designer here, and the editor shows no
    // button rather than one that can only fail.
    if (action === 'post_brief') {
        const postId = Number(body.postId);
        const [designer] = await db.select({ id: aiAssistants.id }).from(aiAssistants)
            .where(and(eq(aiAssistants.organisationId, orgId), sql`(${aiAssistants.configuration} ->> 'type') = ${BRAND_DESIGNER_ROLE_KEY}`)).limit(1);
        if (!designer || !Number.isInteger(postId) || postId <= 0) return json(200, { designerId: designer?.id ?? null, brief: null });
        const [brief] = await db.select({ id: visualBriefs.id, status: visualBriefs.status, aiAssistantId: visualBriefs.aiAssistantId })
            .from(visualBriefs).where(and(
                eq(visualBriefs.organisationId, orgId), eq(visualBriefs.scheduledPostId, postId), sql`${visualBriefs.status} <> 'cancelled'`,
            )).limit(1);
        return json(200, { designerId: designer.id, brief: brief ?? null });
    }

    if (action === 'brief_for_post') {
        const postId = Number(body.postId);
        if (!Number.isInteger(postId) || postId <= 0) return json(400, { error: 'postId is required.' });
        const [post] = await db.select({ caption: scheduledPosts.caption, platform: scheduledPosts.platform }).from(scheduledPosts)
            .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.organisationId, orgId))).limit(1);
        if (!post) return json(404, { error: 'Post not found.' });
        const context = (typeof body.context === 'string' && body.context.trim()) ? body.context : (post.caption || '');
        const blocked = await enforcePromptModeration({ text: context.slice(0, 1000), userId, organisationId: orgId, source: 'brand-briefs' });
        if (blocked) return blocked;
        const briefId = await raiseBriefForPost(db, {
            orgId, postId, context, platform: post.platform,
            mediaType: body.mediaType === 'video' ? 'video' : 'image',
        });
        if (!briefId) return json(404, { error: 'There is no Brand Designer in this workspace to ask.' });
        return json(200, { ok: true, briefId });
    }

    if (action === 'cancel') {
        const brief = await requireBrief(body.briefId);
        if (!brief) return json(404, { error: 'Brief not found.' });
        const r = await cancelBrief(db, orgId, brief.id);
        return r.ok ? json(200, { ok: true }) : json(409, { error: r.error });
    }

    return json(400, { error: `Unknown action "${action}".` });
});
