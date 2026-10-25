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
// Tenant-scoped on every statement; read-only under impersonation (requireTenant).

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { requireTenant } from '../../src/utils/tenant';
import { loadMentorSnapshotData, setupChecklist } from '../../src/utils/mentor-snapshot';
import { recommendHires } from '../../src/utils/mentor-hire';
import { findMentor } from '../../src/utils/mentor-provision';
import { mentorDraftFeedback } from '../../src/utils/mentor-feedback';
import { mentorVisibility } from '../../src/config/mentor-data-inventory';
import {
    DISMISS_REASONS, WEEKLY_CAP, bringBackProposal, decideProposal, isDismissReason, loadOpenProposals, loadProposalState,
} from '../../src/utils/mentor-proposals';

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body),
});

export default withLambda(async (event) => {
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const orgId = ctx.organisationId;

    try {
        if (event.httpMethod === 'GET') {
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
            const id = Number(body.proposalId);
            if (!Number.isInteger(id) || id <= 0) return json(400, { error: 'Which suggestion?' });

            if (body.action === 'decide') {
                const decision = body.decision;
                if (decision !== 'accepted' && decision !== 'dismissed') return json(400, { error: 'Accept or dismiss?' });
                if (decision === 'dismissed' && !isDismissReason(body.reason)) return json(400, { error: 'Pick a reason: not relevant, already done, disagree or not now.' });
                const ok = await decideProposal(db, orgId, ctx.userId, id, decision, isDismissReason(body.reason) ? body.reason : undefined);
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
