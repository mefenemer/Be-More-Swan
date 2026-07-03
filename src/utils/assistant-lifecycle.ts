// src/utils/assistant-lifecycle.ts
// Digital Assistant Lifecycle Management — canonical state machine + transition helper.
//
// The six states an assistant can occupy. `lifecycle_status` on ai_assistants is the source
// of truth (db/assistant-lifecycle-status.sql). A DB trigger keeps it derived from the legacy
// (provisioning_status, is_active) pair for existing write sites; this helper is the forward
// API for explicit, validated transitions — including ready_for_work, which has no legacy equivalent.

import { eq, and } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { aiAssistants, auditLogs } from '../../db/schema';

export const ASSISTANT_STATES = [
    'provisioning',
    'ready_for_work',
    'working',
    'paused',
    'system_paused',
    'archived',
] as const;

export type AssistantLifecycleStatus = (typeof ASSISTANT_STATES)[number];

// Legal transition graph. `archived` is terminal (US6: cannot be undone). Note that the
// historical "auto-activate on provisioning complete" path (provisioning → working) is driven
// by the legacy fields + DB trigger, NOT this helper; US3 will route it through ready_for_work.
export const LEGAL_TRANSITIONS: Record<AssistantLifecycleStatus, AssistantLifecycleStatus[]> = {
    provisioning:   ['ready_for_work', 'system_paused', 'archived'],
    ready_for_work: ['working', 'system_paused', 'archived'],
    working:        ['paused', 'system_paused', 'archived'],
    paused:         ['working', 'system_paused', 'archived'],
    system_paused:  ['ready_for_work', 'working', 'archived'],
    archived:       [],
};

export function isLegalTransition(from: AssistantLifecycleStatus, to: AssistantLifecycleStatus): boolean {
    return from === to || LEGAL_TRANSITIONS[from]?.includes(to) === true;
}

// ── Blocked provisioning (gate-blocked assistants) ──────────────────────────────────────────
// When a compliance/readiness gate stops provision-assistant-background, the assistant is parked
// at provisioning_status='blocked' with one of these machine reason codes in
// provisioning_blocked_reason. The assistant still reads as lifecycle 'provisioning', but these
// give the dashboard, kickoff-assistant and the readiness panel an actionable "here's what to fix".
export const PROVISIONING_BLOCK_REASONS = [
    'disclosure_missing',
    'tos_required',
    'prohibited_use_ack',
    'dpa_required',
    'high_risk_eu',
] as const;

export type ProvisioningBlockReason = (typeof PROVISIONING_BLOCK_REASONS)[number];

// User-facing copy per reason. `cta` is a short label the dashboard can put on the fix button;
// the actual fix flow differs per reason (Guardrails tab, ToS modal, DPA modal, support).
export const PROVISIONING_BLOCK_INFO: Record<ProvisioningBlockReason, { title: string; message: string; cta: string }> = {
    disclosure_missing: {
        title: 'AI disclosure required',
        message: 'Add the AI disclosure text (required by EU AI Act Art. 52) before this assistant can be activated.',
        cta: 'Add disclosure',
    },
    tos_required: {
        title: 'Accept the Terms of Service',
        message: 'You must accept the current Terms of Service before this assistant can be activated.',
        cta: 'Review Terms',
    },
    prohibited_use_ack: {
        title: 'Acknowledgement required',
        message: "This assistant's instructions touch on prohibited-use categories. Review the Terms (clauses 10.3 and 11.4) and acknowledge compliance before activating.",
        cta: 'Review & acknowledge',
    },
    dpa_required: {
        title: 'Accept the Data Processing Agreement',
        message: 'Your organisation must accept the Data Processing Agreement before activating an assistant.',
        cta: 'Review DPA',
    },
    high_risk_eu: {
        title: 'Conformity assessment required',
        message: 'This assistant is classified High Risk under the EU AI Act. A completed conformity assessment must be approved before EU-market deployment.',
        cta: 'Contact support',
    },
};

// Resolve a (possibly stale/unknown) reason code to display copy, with a safe generic fallback.
export function provisioningBlockInfo(reason: string | null | undefined) {
    return (reason && PROVISIONING_BLOCK_INFO[reason as ProvisioningBlockReason]) || {
        title: 'Action required',
        message: 'This assistant needs an action from you before setup can finish.',
        cta: 'Review',
    };
}

export type TransitionResult =
    | { ok: true; from: AssistantLifecycleStatus; to: AssistantLifecycleStatus; noop: boolean }
    | { ok: false; error: string; from?: AssistantLifecycleStatus };

/**
 * Move an assistant to a new lifecycle state, enforcing the legal transition graph and writing
 * an audit-log entry. Also keeps the legacy `is_active` flag aligned (working ⇒ active; every
 * other state ⇒ inactive) so existing job/connector gates that read is_active stay correct.
 *
 * @param force  bypass the legal-transition check (for admin/system overrides). Audited the same.
 */
export async function transitionAssistantStatus(
    db: PostgresJsDatabase<any>,
    assistantId: number,
    to: AssistantLifecycleStatus,
    opts: { reason?: string; actorUserId?: number; force?: boolean } = {},
): Promise<TransitionResult> {
    const [current] = await db
        .select({ lifecycleStatus: aiAssistants.lifecycleStatus, organisationId: aiAssistants.organisationId })
        .from(aiAssistants)
        .where(eq(aiAssistants.id, assistantId))
        .limit(1);

    if (!current) return { ok: false, error: `Assistant ${assistantId} not found.` };

    const from = current.lifecycleStatus as AssistantLifecycleStatus;

    if (from === to) return { ok: true, from, to, noop: true };

    if (!opts.force && !isLegalTransition(from, to)) {
        return { ok: false, error: `Illegal lifecycle transition: ${from} → ${to}.`, from };
    }

    await db.update(aiAssistants)
        .set({ lifecycleStatus: to, isActive: to === 'working', updatedAt: new Date() })
        .where(eq(aiAssistants.id, assistantId));

    await db.insert(auditLogs).values({
        userId: opts.actorUserId ?? null,
        actionType: `assistant_lifecycle_${to}`,
        resourceType: 'ai_assistants',
        resourceId: String(assistantId),
        previousState: { lifecycleStatus: from },
        newState: { lifecycleStatus: to, organisationId: current.organisationId, reason: opts.reason ?? null },
    });

    return { ok: true, from, to, noop: false };
}

/**
 * US5 (AC5.1): force a workspace's currently-working assistants into `system_paused` when a
 * critical dependency breaks (e.g. an OAuth token can't be refreshed). Scoped to a single
 * assistant when `assistantId` is given (assistant-scoped connection), otherwise the whole org
 * (a shared org-pool connection). Only `working` assistants are affected — provisioning,
 * ready_for_work, paused and archived are left alone. Returns the number transitioned.
 */
export async function systemPauseWorkingAssistants(
    db: PostgresJsDatabase<any>,
    filter: { organisationId: number; assistantId?: number | null },
    reason: string,
): Promise<number> {
    const conds = [
        eq(aiAssistants.organisationId, filter.organisationId),
        eq(aiAssistants.lifecycleStatus, 'working'),
    ];
    if (filter.assistantId) conds.push(eq(aiAssistants.id, filter.assistantId));

    const rows = await db.select({ id: aiAssistants.id }).from(aiAssistants).where(and(...conds));

    let paused = 0;
    for (const r of rows) {
        const res = await transitionAssistantStatus(db, r.id, 'system_paused', { reason });
        if (res.ok && !res.noop) paused++;
    }
    return paused;
}
