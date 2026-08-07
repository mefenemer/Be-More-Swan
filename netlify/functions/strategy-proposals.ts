// netlify/functions/strategy-proposals.ts
// The Strategy tab's read + decide API — Phase 5a of
// docs/lead-generator-revenue-engine-plan.md §7. Design: docs/strategy-agent-plan.md §6.
//
//   POST { action: 'list',     assistantId, status? }  → { proposals[], counts, progress, gated }
//   POST { action: 'apply',    assistantId, proposalId }
//   POST { action: 'reject',   assistantId, proposalId, reason, note? }
//   POST { action: 'rollback', assistantId, proposalId, force? }
//
// ── This function decides; it does not write fields ──────────────────────────
// Every mutation delegates to src/utils/strategy-proposals.ts, which is the ONE writer of a
// tunable strategy field. That is §5.4's requirement, not a layering preference: §2.6's human
// "save as default" and an agent pivot must share one apply path, one audit row and one rollback,
// or the second mechanism drifts from the first.
//
// ── Gating ───────────────────────────────────────────────────────────────────
// Behind the `strategy_agent` plan feature, DEFAULT OFF — off being the absence of the key, so no
// environment starts exposed and no seed row is required. Deliberately NOT tierAllows('autonomous'):
// that gate admits the goal optimizer, which rewrites brand voice for an org's OWN content, and
// §7.1 draws the distinction explicitly — "the difference is blast radius" — against an ICP pivot
// that redirects cold outreach at real strangers. See STRATEGY_AGENT_FEATURE for the full argument.
//
// `list` answers with `gated: true` rather than 403 when the feature is off, so the tab can stay
// hidden without the client having to treat a permission error as a normal state.

import { and, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, revenueEvents, strategyProposals, templateFeedback, users } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { hasFeatureByOrg } from '../../src/utils/plan-features';
import { CONFIG_KEYS, getPlatformConfig } from '../../src/utils/platform-config';
import {
    MIN_SAMPLE, REJECT_REASONS, REJECT_REASON_EFFECTS, REJECT_REASON_LABELS,
    STRATEGY_AGENT_FEATURE, STRATEGY_TUNABLE_FIELDS, isProposalStatus, isRejectReason,
    isStrategyAgentEnabledForAssistant, tunableField,
} from '../../src/config/strategy-proposals';
import { MIN_EDIT_SAMPLE } from '../../src/config/template-feedback';
import { applyStrategyChange, rejectProposal, rollbackProposal } from '../../src/utils/strategy-proposals';
import { withLambda } from '@netlify/aws-lambda-compat';

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

/** Proposals are at most one per field per week — the whole history fits comfortably in one page. */
const PAGE_SIZE = 60;

/** Map a DecisionResult failure code onto an HTTP status the client can branch on. */
const STATUS_FOR_CODE: Record<string, number> = {
    not_found: 404,
    not_pending: 409,
    not_applied: 409,
    already_rolled_back: 409,
    changed_since: 409,
    not_tunable: 422,
    invalid_value: 422,
    invalid_reason: 400,
    no_target: 422,
    write_failed: 502,
};

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId, userId } = ctx;

    let body: {
        action?: string; assistantId?: number; proposalId?: number;
        status?: string; reason?: string; note?: string; force?: boolean;
    };
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

    const action = String(body.action || 'list');
    const assistantId = Number(body.assistantId);

    // IDOR guard — the assistant instance must belong to the caller's org. Every query below is
    // additionally scoped by organisationId, so a proposal id from another tenant reads as missing.
    const [assistant] = await db
        .select({ id: aiAssistants.id, name: aiAssistants.name, onboardingContext: aiAssistants.onboardingContext })
        .from(aiAssistants)
        .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, orgId)))
        .limit(1);
    if (!assistant) return json(404, { error: 'Assistant not found.' });

    const enabled = await hasFeatureByOrg(db, orgId, STRATEGY_AGENT_FEATURE);

    // ⚠️ The per-assistant consent switch deliberately does NOT gate this function. It stops the
    // proposers PRODUCING (autonomous-strategy-agent.ts checks it in both passes); gating the API on
    // it too would strand any pending proposal behind a toggle, un-appliable and invisible, which is
    // worse than the silence it was flipped to create. It is reported so the tab can say why nothing
    // new is arriving.
    const assistantPaused = !isStrategyAgentEnabledForAssistant(assistant.onboardingContext);

    // A decision on a hidden feature is refused outright. `list` degrades to a gated response
    // instead, so the tab can render nothing without the client parsing a 403 as a normal state.
    if (!enabled && action !== 'list') {
        return json(403, { error: 'The Strategy Agent is not enabled for this workspace.', code: 'FEATURE_OFF' });
    }

    try {
        // ── list ──────────────────────────────────────────────────────────────
        if (action === 'list') {
            if (!enabled) {
                return json(200, { gated: true, proposals: [], counts: {}, progress: null, vocab: null, lastRun: null });
            }

            const wanted = isProposalStatus(body.status) ? body.status : null;

            const rows = await db
                .select({
                    id: strategyProposals.id,
                    source: strategyProposals.source,
                    targetField: strategyProposals.targetField,
                    previousValue: strategyProposals.previousValue,
                    proposedValue: strategyProposals.proposedValue,
                    evidence: strategyProposals.evidence,
                    status: strategyProposals.status,
                    rejectReason: strategyProposals.rejectReason,
                    rejectNote: strategyProposals.rejectNote,
                    appliedAt: strategyProposals.appliedAt,
                    rolledBackAt: strategyProposals.rolledBackAt,
                    decidedAt: strategyProposals.decidedAt,
                    expiresAt: strategyProposals.expiresAt,
                    createdAt: strategyProposals.createdAt,
                    decidedByFirstName: users.firstName,
                    decidedByLastName: users.lastName,
                })
                .from(strategyProposals)
                .leftJoin(users, eq(users.id, strategyProposals.decidedBy))
                .where(and(
                    eq(strategyProposals.organisationId, orgId),
                    eq(strategyProposals.aiAssistantId, assistantId),
                    ...(wanted ? [eq(strategyProposals.status, wanted)] : []),
                ))
                .orderBy(desc(strategyProposals.createdAt))
                .limit(PAGE_SIZE);

            const countRows = await db
                .select({ status: strategyProposals.status, n: sql<number>`count(*)::int` })
                .from(strategyProposals)
                .where(and(
                    eq(strategyProposals.organisationId, orgId),
                    eq(strategyProposals.aiAssistantId, assistantId),
                ))
                .groupBy(strategyProposals.status);

            const counts: Record<string, number> = { pending: 0, applied: 0, rejected: 0, expired: 0 };
            for (const c of countRows) counts[c.status] = c.n;

            return json(200, {
                gated: false,
                assistantPaused,
                proposals: rows.map((r) => {
                    const field = tunableField(r.targetField);
                    const { decidedByFirstName, decidedByLastName, ...rest } = r;
                    return {
                        ...rest,
                        decidedByName: [decidedByFirstName, decidedByLastName].filter(Boolean).join(' ') || null,
                        // Resolved server-side so the client never has to know the allow-list, and
                        // an unknown field renders as itself rather than as a blank label.
                        fieldLabel: field?.label ?? r.targetField,
                        fieldDescription: field?.description ?? null,
                        valueType: field?.valueType ?? 'json',
                        canRollback: !!r.appliedAt && !r.rolledBackAt,
                    };
                }),
                counts,
                progress: await evidenceProgress(db, orgId, assistantId),
                // §7: "the last run's timestamp and skip reason, so 'is this thing even running?'
                // is answerable without the logs". Necessary rather than nice now that the run is a
                // background function whose HTTP response is only an ack.
                lastRun: await lastStrategyRun(),
                // Sent with the list so the reject dialog can show what each reason DOES, which is
                // what makes the choice something other than arbitrary.
                vocab: {
                    rejectReasons: REJECT_REASONS.map((r) => ({
                        key: r, label: REJECT_REASON_LABELS[r], effect: REJECT_REASON_EFFECTS[r],
                    })),
                    fields: Object.entries(STRATEGY_TUNABLE_FIELDS).map(([key, f]) => ({ key, label: f.label })),
                },
            });
        }

        const proposalId = Number(body.proposalId);
        if (!Number.isInteger(proposalId)) return json(400, { error: 'Which proposal?' });

        // ── apply ─────────────────────────────────────────────────────────────
        if (action === 'apply') {
            const result = await applyStrategyChange(db, { proposalId, organisationId: orgId, userId });
            if (!result.ok) return json(STATUS_FOR_CODE[result.code] ?? 400, { error: result.message, code: result.code });
            return json(200, { applied: true, proposalId: result.proposalId, recompiled: result.recompiled });
        }

        // ── reject ────────────────────────────────────────────────────────────
        if (action === 'reject') {
            if (!isRejectReason(body.reason)) {
                return json(400, { error: 'Pick a reason from the list.', code: 'invalid_reason' });
            }
            const result = await rejectProposal(db, {
                proposalId, organisationId: orgId, reason: body.reason,
                note: typeof body.note === 'string' ? body.note : null, userId,
            });
            if (!result.ok) return json(STATUS_FOR_CODE[result.code] ?? 400, { error: result.message, code: result.code });
            return json(200, { rejected: true, proposalId: result.proposalId });
        }

        // ── rollback ──────────────────────────────────────────────────────────
        if (action === 'rollback') {
            const result = await rollbackProposal(db, {
                proposalId, organisationId: orgId, userId, force: body.force === true,
            });
            if (!result.ok) {
                return json(STATUS_FOR_CODE[result.code] ?? 400, {
                    error: result.message, code: result.code,
                    // The screen needs to SHOW what the field changed to before asking again.
                    ...(result.currentValue !== undefined ? { currentValue: result.currentValue } : {}),
                });
            }
            return json(200, { rolledBack: true, proposalId: result.proposalId, recompiled: result.recompiled });
        }

        return json(400, { error: `Unknown action "${action}".` });
    } catch (err) {
        // db/strategy-proposals.sql is a MANUAL apply. On an un-migrated environment say so plainly;
        // a generic 502 sends you looking for a bug that isn't there.
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('does not exist') && (msg.includes('column') || msg.includes('relation'))) {
            console.error('[strategy-proposals] schema not migrated — apply db/strategy-proposals.sql', err);
            return json(503, { error: 'The Strategy Agent is not set up on this environment yet.', code: 'MIGRATION_PENDING' });
        }
        // postgres-js wraps the real failure — "Failed query" alone tells you nothing, read `cause`.
        const pg = err as { code?: string; constraint_name?: string; cause?: unknown };
        console.error('[strategy-proposals]', { action, orgId, assistantId, pgCode: pg?.code, cause: pg?.cause }, err);
        return json(502, { error: 'The Strategy Agent is having trouble right now — please try again.' });
    }
});

/**
 * How close each proposer is to having enough evidence to fire.
 *
 * This is the whole point of §7's empty state. For months every real Strategy tab will show no
 * proposals, which is CORRECT — "no pivot on noise" is the safety argument — but a screen that
 * renders a blank card for a quarter reads as broken and generates support tickets. So the empty
 * state is diagnostic: it names which input is missing and how far off it is.
 *
 * ⚠️ Terminal outcomes are counted as the LATEST per record, not as raw rows: correcting an outcome
 * APPENDS a second terminal event (the ledger is append-only), so a naive count double-counts every
 * correction and would show a threshold as met when it is not.
 */
/**
 * When the weekly run last happened and what it did.
 *
 * Platform-wide, because the cron is — there is one run covering every org, so "when did the agent
 * last look?" has one answer. Deliberately NOT tenant-scoped data: counts and reason strings only.
 * Never throws; an unreadable summary just means the tab omits the line.
 */
async function lastStrategyRun() {
    try {
        const raw = await getPlatformConfig(CONFIG_KEYS.STRATEGY_AGENT_LAST_RUN);
        if (!raw || typeof raw !== 'object') return null;
        const r = raw as Record<string, unknown>;
        return {
            at: typeof r.at === 'string' ? r.at : null,
            proposed: Number(r.proposed ?? 0),
            clusters: Number(r.clusters ?? 0),
            truncated: r.truncated === true,
            // A BOOLEAN, never the reason itself. haltReason carries a thrown error's message,
            // which can quote SQL and table names; the tenant needs to know the check did not
            // complete, not what broke. Operators read the full string in platform_config.
            halted: typeof r.haltReason === 'string' && r.haltReason.length > 0,
            // One line is enough for a diagnostic strip; the rest is in the logs.
            skipReason: Array.isArray(r.skipReasons) && r.skipReasons.length
                ? String(r.skipReasons[0])
                : null,
        };
    } catch {
        return null;
    }
}

async function evidenceProgress(db: ReturnType<typeof getDb>, orgId: number, assistantId: number) {
    const [outcomes] = await db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM (
            SELECT DISTINCT ON (assistant_record_id) id
              FROM ${revenueEvents}
             WHERE organisation_id = ${orgId}
               AND ai_assistant_id = ${assistantId}
               AND outcome IS NOT NULL
               AND assistant_record_id IS NOT NULL
             ORDER BY assistant_record_id, occurred_at DESC
        ) latest`);

    // ⚠️ The MODAL reason's count, not the total — and filtered to exactly what the proposer can
    // actually use. A plain count of unbanked rows overstates progress three ways: it includes
    // 'other' (a bucket, deliberately unclusterable), rows with no assistant to attribute a playbook
    // to, and rows spread across different reasons that will never form one cluster. Showing "4 of 5"
    // for four unrelated complaints promises a proposal that can never arrive.
    const [edits] = await db.execute<{ n: number }>(sql`
        SELECT COALESCE(max(n), 0)::int AS n FROM (
            SELECT count(*)::int AS n
              FROM ${templateFeedback} tf
              LEFT JOIN lead_messages lm ON lm.id = tf.lead_message_id
              LEFT JOIN lead_threads  lt ON lt.id = lm.lead_thread_id
             WHERE tf.organisation_id = ${orgId}
               AND tf.applied_to_template = false
               AND tf.edit_reason IS NOT NULL
               AND tf.edit_reason <> 'other'
               AND COALESCE(tf.ai_assistant_id, lt.ai_assistant_id) = ${assistantId}
             GROUP BY tf.edit_reason
        ) clusters`);

    return {
        winLoss: { have: Number(outcomes?.n ?? 0), need: MIN_SAMPLE },
        editPattern: { have: Number(edits?.n ?? 0), need: MIN_EDIT_SAMPLE },
    };
}
