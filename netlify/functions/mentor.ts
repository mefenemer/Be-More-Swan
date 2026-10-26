// netlify/functions/mentor.ts
// The Business Mentor's own page and its suggestions (docs/business-mentor-plan.md §3.13, §14).
// One server action per capability: the Overview tab (assistants.js) and the chat cards
// (disruptive-ui-registry.js → chat-session.js) both call this.
//
// GET                                               → { checklist, visibility, dismissed, week, open, recommended }
//     checklist  — the "Set-up checklist": the same gaps the Mentor raises (mentor-snapshot.ts setupChecklist)
//     visibility — "What I can see", generated from src/config/mentor-data-inventory.ts
//     dismissed  — "Dismissed suggestions", each with "Bring back"
//     week       — { used, cap }: suggestions shown since Monday (direct asks don't count)
//     open       — suggestions still waiting, for "Review all" (mentor-review-all.js: chat, Overview, Inbox)
//     recommended — "Recommended next": who to hire next (mentor-hire.ts, the same list as the chat card)
// GET ?only=recommended                             → { recommended }  the catalogue's "Recommended" badge
// GET ?only=open                                    → { open: [{ id, kind, title }] }  Inbox "Needs you"'s strip
// POST { action: 'feedback', text }                  → { feedback }  the "Get feedback" box (mentor-feedback.ts)
// POST { action: 'decide', proposalId, decision: 'accepted' }            → { ok }  after a card's click saved
// POST { action: 'decide', proposalId, decision: 'dismissed', reason }   → { ok }  the card's Dismiss
//     reason ∈ not_relevant | already_done | disagree | not_now (not_now snoozes 14 days)
// POST { action: 'bring_back', proposalId }                               → { ok }  the Overview's "Bring back"
//
// Phase 2 — the Plan tab (assistant-mentor-plan.js) and the chat's plan cards (mentor-apply.js):
// GET ?plan=1                                       → { ready, kinds, docs, canApprove, stage, playbook, research, drafting }
// GET ?job=<id>                                     → { job }  a research or drafting job, for the card's and the page's poll
// POST { action: 'strategy_save', kind, sections, assumptions? }   → { doc }  Save draft / form step / canvas / card
// POST { action: 'strategy_approve', kind, draftId, updatedAt }    → { doc }  Approve (owner or admin); recompiles blueprints
// POST { action: 'strategy_draft', kind, chatSessionId? }          → { job }  "Draft it for me" (1 task, background)
// POST { action: 'research', question, chatSessionId? }            → { job }  "Look this up" (1 task, background)
// POST { action: 'break_even', inputs }                            → { result }  the calculator (break-even.ts, in code)
//
// Phase 3 — the weekly review (§5): the Overview tab's Reviews, Track record and Customers panels, the
// Results tab's Commitments list (mentor-commitments.js) and the chat's commitments card (mentor-apply.js):
// GET ?reviews=1                                    → { ready, reviews, settings, canRun, trackRecord, trackReady }
// GET ?customers=1                                  → { customers }  (mentor-customers.ts: active assistants only, names and dates only)
// GET ?commitments=1                                → { ready, commitments, me, canManage, week, maxPerWeek, missReasons }
// POST { action: 'review_now' }                                   → { review }  "Review my week now" (owner or admin; 1 task, background)
// POST { action: 'commitments_add', texts: [...] }                → { commitments }  "Add" / the card's "Save these"
// POST { action: 'commitment_close', id, status, missReason?, note? } → { commitments }  Done / Missed (why) / Drop
// An accepted suggestion is also remembered for the track record (mentor-outcomes.ts recordOutcome).
//
// Tenant-scoped on every statement; read-only under impersonation (requireTenant).

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { requireTenant } from '../../src/utils/tenant';
import { loadMentorSnapshotData, setupChecklist } from '../../src/utils/mentor-snapshot';
import { recommendHires } from '../../src/utils/mentor-hire';
import { findMentor } from '../../src/utils/mentor-provision';
import { mentorDraftFeedback } from '../../src/utils/mentor-feedback';
import { mentorVisibility } from '../../src/config/mentor-data-inventory';
import { breakEven, BREAK_EVEN_INPUTS, BREAK_EVEN_KEYS } from '../../src/utils/break-even';
import {
    STRATEGY_KINDS, STRATEGY_KIND_KEYS, approveStrategyDraft, bodyIsEmpty, canApproveStrategy, diffStrategy, isStrategyKind,
    loadPrefillSources, loadStrategyDocs, pickVersions, prefillStrategy, saveStrategyDraft, type StrategyDoc,
} from '../../src/utils/strategy-documents';
import { loadMentorJob, loadMentorJobs, queueMentorJob } from '../../src/utils/mentor-jobs';
import { playbookFor } from '../../src/config/mentor-playbooks';
import { recompileOrgBlueprints } from '../../src/utils/recompile-org-blueprints';
import { aiAssistants } from '../../db/schema';
import { and, eq, sql } from 'drizzle-orm';
import {
    DISMISS_REASONS, WEEKLY_CAP, bringBackProposal, decideProposal, isDismissReason, loadOpenProposals, loadProposalState,
} from '../../src/utils/mentor-proposals';
import { loadReviews, queueReviewNow, REVIEW_ROLES, reviewSettings } from '../../src/utils/mentor-review';
import { loadTrackRecord, recordOutcome } from '../../src/utils/mentor-outcomes';
import { loadCustomers } from '../../src/utils/mentor-customers';
import { addCommitments, closeCommitment, loadCommitments, MAX_PER_WEEK, MISS_REASONS, weekStartUk } from '../../src/utils/mentor-commitments';

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body),
});

const docView = (d: StrategyDoc | null) => d && ({
    id: d.id, version: d.version, status: d.status, body: d.body,
    approvedAt: d.approvedAt?.toISOString() ?? null, updatedAt: d.updatedAt?.toISOString() ?? null,
});

/** The Plan tab: every document (draft, approved, earlier versions, the diff), a pre-draft where none exists. */
async function planView(db: any, orgId: number, role: string) {
    const docs = await loadStrategyDocs(db, orgId);
    const [prefillSources, research, drafting, mentorRow] = await Promise.all([
        loadPrefillSources(db, orgId),
        loadMentorJobs(db, orgId, 'research').catch(() => null),
        loadMentorJobs(db, orgId, 'strategy_draft', 10).catch(() => null),
        findMentor(db, orgId),
    ]);
    let stage: string | null = null;
    if (mentorRow) {
        const [r] = await db.select({ stage: sql<string | null>`${aiAssistants.onboardingContext} ->> 'businessStage'` }).from(aiAssistants)
            .where(and(eq(aiAssistants.id, mentorRow.id), eq(aiAssistants.organisationId, orgId))).limit(1);
        stage = r?.stage ?? null;
    }
    const byKind = Object.fromEntries(STRATEGY_KIND_KEYS.map((kind) => {
        const { draft, approved, earlier } = pickVersions(docs ?? [], kind);
        return [kind, {
            draft: docView(draft), approved: docView(approved), earlier: earlier.map(docView),
            diff: draft ? diffStrategy(kind, approved?.body ?? null, draft.body) : [],
            // §13.2: an existing workspace's plans start pre-filled from what's already saved — shown, never saved until Save draft.
            prefill: !draft && !approved ? prefillStrategy(kind, prefillSources) : null,
        }];
    }));
    const choice = playbookFor(prefillSources.offerKinds);
    return {
        ready: docs !== null,
        kinds: Object.fromEntries(STRATEGY_KIND_KEYS.map((k) => [k, { label: STRATEGY_KINDS[k].label, sections: STRATEGY_KINDS[k].sections, hasAssumptions: !!STRATEGY_KINDS[k].hasAssumptions }])),
        docs: byKind,
        canApprove: canApproveStrategy(role),
        stage,
        playbook: { inUse: choice.inUse, awaitingReview: choice.awaitingReview },
        research: research ?? [],
        researchReady: research !== null,
        drafting: drafting ?? [],
        breakEvenInputs: Object.fromEntries(BREAK_EVEN_KEYS.map((k) => [k, BREAK_EVEN_INPUTS[k]])),
    };
}

export default withLambda(async (event) => {
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const orgId = ctx.organisationId;

    try {
        if (event.httpMethod === 'GET') {
            if (event.queryStringParameters?.plan) return json(200, await planView(db, orgId, ctx.role));
            if (event.queryStringParameters?.reviews) {
                const mentorRow = await findMentor(db, orgId);
                let ctxRow: unknown = null;
                if (mentorRow) {
                    const [r] = await db.select({ c: aiAssistants.onboardingContext }).from(aiAssistants)
                        .where(and(eq(aiAssistants.id, mentorRow.id), eq(aiAssistants.organisationId, orgId))).limit(1);
                    ctxRow = r?.c ?? null;
                }
                const [reviews, trackRecord] = await Promise.all([loadReviews(db, orgId, ctx.userId), loadTrackRecord(db, orgId)]);
                return json(200, {
                    ready: reviews !== null, reviews: reviews ?? [], settings: reviewSettings(ctxRow), canRun: REVIEW_ROLES.includes(String(ctx.role)),
                    trackRecord: trackRecord ?? [], trackReady: trackRecord !== null,
                });
            }
            if (event.queryStringParameters?.customers) return json(200, { customers: await loadCustomers(db, orgId) });
            if (event.queryStringParameters?.commitments) {
                const list = await loadCommitments(db, orgId, ctx.userId);
                return json(200, {
                    ready: list !== null, commitments: list ?? [], me: ctx.userId, canManage: REVIEW_ROLES.includes(String(ctx.role)),
                    week: weekStartUk(), maxPerWeek: MAX_PER_WEEK, missReasons: MISS_REASONS,
                });
            }
            if (event.queryStringParameters?.job) {
                const jobId = Number(event.queryStringParameters.job);
                const job = Number.isInteger(jobId) && jobId > 0 ? await loadMentorJob(db, orgId, jobId) : null;
                return job ? json(200, { job }) : json(404, { error: 'That isn’t one of your Mentor’s jobs.' });
            }
            if (event.queryStringParameters?.only === 'open') return json(200, { open: (await loadOpenProposals(db, orgId)).map((o) => ({ id: o.id, kind: o.kind, title: o.title })) });
            if (event.queryStringParameters?.only === 'recommended') {
                // Only a workspace that has a Mentor: the catalogue's badge says "Your Mentor".
                if (!(await findMentor(db, orgId))) return json(200, { recommended: null });
                const rec = recommendHires(await loadMentorSnapshotData(db, orgId, ctx.userId));
                return json(200, { recommended: rec });
            }
            const [data, state, open] = await Promise.all([loadMentorSnapshotData(db, orgId, ctx.userId), loadProposalState(db, orgId), loadOpenProposals(db, orgId)]);
            return json(200, {
                checklist: setupChecklist(data).map(({ gap: _gap, ...item }) => item),
                visibility: mentorVisibility(),
                dismissed: (state?.dismissed ?? []).map((d) => ({
                    id: d.id, title: d.title, why: d.why, reason: d.reason, reasonLabel: DISMISS_REASONS[d.reason],
                    snoozedUntil: d.snoozedUntil?.toISOString() ?? null, decidedAt: d.decidedAt?.toISOString() ?? null,
                })),
                week: { used: state?.usedThisWeek ?? null, cap: WEEKLY_CAP },
                open: open.map((o) => ({ id: o.id, kind: o.kind, title: o.title, why: o.why, card: o.card, shownAt: o.shownAt?.toISOString() ?? null })),
                recommended: recommendHires(data),
            });
        }

        if (event.httpMethod === 'POST') {
            let body: Record<string, unknown>;
            try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid request.' }); }
            if (body.action === 'feedback') {
                const r = await mentorDraftFeedback(db, orgId, ctx.userId, body.text);
                return r.ok ? json(200, { feedback: r.feedback }) : json(r.status, { error: r.error, ...(r.code ? { code: r.code } : {}) });
            }
            // ── Phase 2: the Plan tab and the chat's plan cards ──
            if (body.action === 'strategy_save' || body.action === 'strategy_approve' || body.action === 'strategy_draft') {
                if (!isStrategyKind(body.kind)) return json(400, { error: 'Which document?' });
                if (body.action === 'strategy_save') {
                    const r = await saveStrategyDraft(db, orgId, ctx.userId, body.kind, { sections: body.sections, assumptions: body.assumptions });
                    return r.ok ? json(200, { doc: docView(r.doc) }) : json(r.status, { error: r.error });
                }
                if (body.action === 'strategy_approve') {
                    // §2.5: approving changes what every assistant drafts from — the roles that manage the workspace.
                    if (!canApproveStrategy(ctx.role)) return json(403, { error: 'Only the workspace owner or an admin can approve a plan. You can still save the draft.' });
                    const r = await approveStrategyDraft(db, orgId, ctx.userId, body.kind, { draftId: body.draftId, updatedAt: body.updatedAt });
                    if (!r.ok) return json(r.status, { error: r.error });
                    // §4.4: approved documents reach drafting through business-knowledge.ts; rebuild every blueprint now.
                    await recompileOrgBlueprints(db, orgId, `strategy approved: ${body.kind} v${r.doc.version}`);
                    return json(200, { doc: docView(r.doc) });
                }
                const r = await queueMentorJob(db, { orgId, userId: ctx.userId, kind: 'strategy_draft', strategyKind: body.kind, chatSessionId: body.chatSessionId });
                return r.ok ? json(202, { job: r.job }) : json(r.status, { error: r.error, ...(r.code ? { code: r.code } : {}) });
            }
            if (body.action === 'research') {
                const r = await queueMentorJob(db, { orgId, userId: ctx.userId, kind: 'research', question: body.question, chatSessionId: body.chatSessionId });
                return r.ok ? json(202, { job: r.job }) : json(r.status, { error: r.error, ...(r.code ? { code: r.code } : {}) });
            }
            // ── Phase 3: the weekly review and commitments ──
            if (body.action === 'review_now') {
                const r = await queueReviewNow(db, orgId, ctx.userId, ctx.role);
                return r.ok ? json(202, { review: r.review }) : json(r.status, { error: r.error, ...(r.code ? { code: r.code } : {}) });
            }
            if (body.action === 'commitments_add') {
                const r = await addCommitments(db, orgId, ctx.userId, body.texts);
                return r.ok ? json(200, { commitments: r.commitments }) : json(r.status, { error: r.error });
            }
            if (body.action === 'commitment_close') {
                const r = await closeCommitment(db, orgId, ctx.userId, ctx.role, { id: body.id, status: body.status, missReason: body.missReason, note: body.note });
                return r.ok ? json(200, { commitments: r.commitments }) : json(r.status, { error: r.error });
            }
            if (body.action === 'break_even') {
                const r = breakEven(body.inputs && typeof body.inputs === 'object' ? body.inputs as Record<string, unknown> : {});
                return r.ok ? json(200, { result: r }) : json(400, { error: r.error });
            }

            const id = Number(body.proposalId);
            if (!Number.isInteger(id) || id <= 0) return json(400, { error: 'Which suggestion?' });

            if (body.action === 'decide') {
                const decision = body.decision;
                if (decision !== 'accepted' && decision !== 'dismissed') return json(400, { error: 'Accept or dismiss?' });
                if (decision === 'dismissed' && !isDismissReason(body.reason)) return json(400, { error: 'Pick a reason: not relevant, already done, disagree or not now.' });
                const ok = await decideProposal(db, orgId, ctx.userId, id, decision, isDismissReason(body.reason) ? body.reason : undefined);
                // §5.3: remember what an accepted suggestion changed and the measure it was meant to move.
                if (ok && decision === 'accepted') await recordOutcome(db, orgId, id);
                return ok ? json(200, { ok: true }) : json(404, { error: 'That suggestion has already been answered.' });
            }
            if (body.action === 'bring_back') {
                const ok = await bringBackProposal(db, orgId, id);
                return ok ? json(200, { ok: true }) : json(404, { error: 'That suggestion isn\'t dismissed any more.' });
            }
            return json(400, { error: 'Unknown action.' });
        }
        return json(405, { error: 'Method not allowed' });
    } catch (err) {
        console.error('[mentor] failed:', err);
        return json(500, { error: 'Your Mentor couldn\'t do that just now — please try again.' });
    }
});
