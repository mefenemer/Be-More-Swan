// src/utils/onboarding-guard.ts
// Epic: Workspace Onboarding Guardrails — US3 (Backend API Guardrails)
//
// Server-side enforcement that a user has finished onboarding before the API
// will serve data for restricted areas (Review Queue, Calendar, Export).
//
// Source of truth: onboarding is "complete" once the user has at least one AI
// assistant set up — the same signal get-onboarding-status.ts reports to the UI.
// We deliberately do NOT rely on a stored `onboarding_completed` boolean: a prior
// `preferences.onboardingComplete` flag was never written by any function and so
// always read as undefined (see get-onboarding-status.ts). Deriving from the
// assistants table keeps the gate honest.

import { eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants } from '../../db/schema';
import type { JsonResponse } from './session';

type Db = ReturnType<typeof getDb>;

/** True once the user has provisioned at least one AI assistant. */
export async function hasCompletedOnboarding(db: Db, userId: number): Promise<boolean> {
    const [assistant] = await db
        .select({ id: aiAssistants.id })
        .from(aiAssistants)
        .where(eq(aiAssistants.userId, userId))
        .limit(1);
    return !!assistant;
}

/**
 * AC3.2: the canonical 403 response for an onboarding-gated endpoint. The
 * machine-readable `error` code lets the frontend (AC3.3) recognise this case
 * distinctly from auth/permission failures.
 */
export function onboardingForbidden(): JsonResponse {
    return {
        statusCode: 403,
        body: JSON.stringify({
            error: 'onboarding_incomplete',
            message: 'Please complete your onboarding checklist to unlock this feature.',
        }),
    };
}

/**
 * AC3.1: middleware-style guard. Call after the handler has resolved `userId`:
 *
 *   const denied = await requireOnboarding(db, userId);
 *   if (denied) return denied;
 *
 * Returns the 403 JsonResponse when onboarding is incomplete, or `null` to proceed.
 */
export async function requireOnboarding(db: Db, userId: number): Promise<JsonResponse | null> {
    const complete = await hasCompletedOnboarding(db, userId);
    return complete ? null : onboardingForbidden();
}
