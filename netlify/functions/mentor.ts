// netlify/functions/mentor.ts
// The Business Mentor's own page and its suggestions (docs/business-mentor-plan.md §3.13, §14).
// One server action per capability: the Overview tab (assistants.js) and the chat cards
// (disruptive-ui-registry.js → chat-session.js) both call this.
//
// GET                                               → { checklist, visibility, dismissed, week }
//     checklist  — the "Set-up checklist": the same gaps the Mentor raises (mentor-snapshot.ts setupChecklist)
//     visibility — "What I can see", generated from src/config/mentor-data-inventory.ts
//     dismissed  — "Dismissed suggestions", each with "Bring back"
//     week       — { used, cap }: suggestions shown since Monday (direct asks don't count)
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
import { mentorVisibility } from '../../src/config/mentor-data-inventory';
import {
    DISMISS_REASONS, WEEKLY_CAP, bringBackProposal, decideProposal, isDismissReason, loadProposalState,
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
            const [data, state] = await Promise.all([loadMentorSnapshotData(db, orgId, ctx.userId), loadProposalState(db, orgId)]);
            return json(200, {
                checklist: setupChecklist(data).map(({ gap: _gap, ...item }) => item),
                visibility: mentorVisibility(),
                dismissed: (state?.dismissed ?? []).map((d) => ({
                    id: d.id, title: d.title, why: d.why, reason: d.reason, reasonLabel: DISMISS_REASONS[d.reason],
                    snoozedUntil: d.snoozedUntil?.toISOString() ?? null, decidedAt: d.decidedAt?.toISOString() ?? null,
                })),
                week: { used: state?.usedThisWeek ?? null, cap: WEEKLY_CAP },
            });
        }

        if (event.httpMethod === 'POST') {
            let body: Record<string, unknown>;
            try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid request.' }); }
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
