// src/utils/mentor-provision.ts
// Give a workspace its Business Mentor (docs/business-mentor-plan.md §2.3, §13.1).
//
// Every workspace gets one, on every plan, without a hire: it is created the first time the workspace
// loads its assistants (get-assistants.ts) once the `business_mentor` feature flag lets that workspace
// in. One per workspace, safe to call on every load, and it never takes a plan seat
// (assistant-capacity.ts WORKSPACE_ROLE_KEYS — this row's configuration.type is what that rule reads).
//
// Deliberately NOT gated on the catalogue status: the role stays Hidden in the catalogue (nobody can
// hire it) while the flag decides which workspaces have it — the rollout in §8.5.
//
// Never throws: a failure here must not stop the workspace's assistants from loading.

import { and, eq, sql } from 'drizzle-orm';
import { aiAssistants, chatSessions, masterAssistants } from '../../db/schema';
import { isFeatureEnabled } from './feature-flags';

export const MENTOR_ROLE_KEY = 'business_mentor';
export const MENTOR_FLAG = 'business_mentor';

type Db = any;

export type MentorProvisionResult =
    | { status: 'off' }                       // the flag doesn't include this workspace
    | { status: 'exists'; assistantId: number }
    | { status: 'created'; assistantId: number }
    | { status: 'no_catalogue' }              // db/z-business-mentor.sql not applied
    | { status: 'failed' };

/** The workspace's Mentor id, whatever its state, or null. Matches by role, like hire-assistant's one-per-role check. */
export async function findMentor(db: Db, orgId: number): Promise<{ id: number } | null> {
    const [row] = await db
        .select({ id: aiAssistants.id })
        .from(aiAssistants)
        .where(and(
            eq(aiAssistants.organisationId, orgId),
            sql`${aiAssistants.configuration} ->> 'type' = ${MENTOR_ROLE_KEY}`,
        ))
        .limit(1);
    return row ?? null;
}

/**
 * Is this chat turn addressed to the workspace's Mentor? Read before the turn's session exists, from
 * what the browser sent (an existing conversation, or the assistant to start one with). The chat route
 * asks only when the workspace has no plan: the Mentor still answers then, in help-only mode (§2.7).
 */
export async function isMentorTurn(db: Db, orgId: number, body: { chatSessionId?: unknown; aiAssistantId?: unknown }): Promise<boolean> {
    try {
        const mentor = await findMentor(db, orgId);
        if (!mentor) return false;
        if (body.chatSessionId !== undefined) {
            const [session] = await db
                .select({ aiAssistantId: chatSessions.aiAssistantId })
                .from(chatSessions)
                .where(and(eq(chatSessions.id, Number(body.chatSessionId)), eq(chatSessions.organisationId, orgId)))
                .limit(1);
            return session?.aiAssistantId === mentor.id;
        }
        return Number(body.aiAssistantId) === mentor.id;
    } catch {
        return false; // unsure → the paywall, as before
    }
}

export async function ensureMentor(db: Db, orgId: number, userId: number): Promise<MentorProvisionResult> {
    try {
        if (!(await isFeatureEnabled(orgId, MENTOR_FLAG))) return { status: 'off' };

        // Any state counts, archived included: the Mentor can be quietened but not removed (§2.3), so
        // an existing row is never replaced by a second one.
        const existing = await findMentor(db, orgId);
        if (existing) return { status: 'exists', assistantId: existing.id };

        const [master] = await db
            .select({ id: masterAssistants.id, name: masterAssistants.name })
            .from(masterAssistants)
            .where(eq(masterAssistants.roleKey, MENTOR_ROLE_KEY))
            .limit(1);
        if (!master) return { status: 'no_catalogue' };

        const [created] = await db.insert(aiAssistants).values({
            organisationId: orgId,
            userId,
            masterAssistantId: master.id,
            name: master.name,
            // The live model is the role's setting on Admin ▸ Assistants ▸ Model & rules (Opus 5.5 by
            // db/z-business-mentor.sql); this column is informational, as for every role.
            model: 'claude-opus-5-5',
            aiAssistantJobRole: master.name,
            systemPrompt: null, // chat-orchestrator ROUTES.business_mentor builds the prompt
            configuration: { type: MENTOR_ROLE_KEY, active: true },
            onboardingContext: {},
            // EU AI Act Art. 50 disclosure, as every assistant carries.
            disclosureText: `You're chatting with ${master.name}, an AI assistant. AI-generated responses may be inaccurate — always review important information before acting on it.`,
            isActive: true,
            provisioningStatus: 'complete', // the lifecycle trigger derives 'working': chattable at once
        }).returning({ id: aiAssistants.id });
        return { status: 'created', assistantId: created.id };
    } catch (err: any) {
        // Two tabs loading at once: the other one created it (ai_assistants_org_name_unique).
        if (err?.code === '23505' || err?.cause?.code === '23505') {
            const again = await findMentor(db, orgId).catch(() => null);
            if (again) return { status: 'exists', assistantId: again.id };
        }
        console.error('[mentor-provision] could not provision the Business Mentor (non-blocking):', err);
        return { status: 'failed' };
    }
}
