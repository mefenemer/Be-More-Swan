// src/utils/release-paused-limit.ts
// Give back the assistants a plan can now afford.
//
// ── Why this had to exist ────────────────────────────────────────────────────
// `provisioningStatus = 'paused_limit'` means "a downgrade left more assistants than the tier
// allows". It had exactly ONE writer (stripe-webhook.ts, on downgrade) and NO releaser. The two
// adjacent recovery paths both exclude it by name — stripe-webhook resumes only `paused_payment`,
// resume-quota-paused.ts only `paused_quota`, its comment saying "paused_payment / paused_limit are
// other systems' pauses and are likewise untouched".
//
// So a customer who did the obvious thing — archive an assistant to get back under their limit —
// stayed paused. Observed 2026-08-23: an org 4-over-3 archived one assistant at 06:47 and the
// paused assistant's row was still untouched from four days earlier. The only self-service route
// was to archive the paused assistant and reinstate it, i.e. archive something you want to keep.
//
// ⚠️ Resumes ONLY `paused_limit`. `paused_payment` is someone else's gate, `paused_quota` clears
// itself on the 1st, and an assistant the user switched off is `complete` + isActive=false and must
// stay off. Keeping those apart is the whole reason the statuses are distinct.
//
// Never throws: this runs as a side effect of archiving and of billing webhooks, and neither should
// fail because a courtesy resume did not work out.

import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, masterPlans, organisations, plans } from '../../db/schema';
import { effectiveLimit, type FeatureOverrides } from './plan-features';

type Db = ReturnType<typeof getDb>;

export interface ReleaseResult {
    resumed: Array<{ id: number; name: string }>;
    /** Seats free after the release. null when the plan is uncapped. */
    remaining: number | null;
}

const NOTHING: ReleaseResult = { resumed: [], remaining: null };

/**
 * Resume `paused_limit` assistants up to whatever the plan now allows.
 *
 * Call after anything that can resolve the over-limit condition: an assistant being archived, or a
 * plan change raising the ceiling.
 */
export async function releasePausedLimit(db: Db, userId: number, organisationId: number): Promise<ReleaseResult> {
    try {
        // The same resolution manage-assistant.ts uses for its capacity gate: a "new subscribers
        // only" frozen snapshot wins over the live master limit, and referral bonus seats stack on
        // top. Resolving it differently here would let one surface hand back a seat the other
        // refuses to accept.
        const [planRow] = await db
            .select({ assistantLimit: masterPlans.assistantLimit, featureOverrides: plans.featureOverrides })
            .from(plans)
            .leftJoin(masterPlans, eq(plans.masterPlanId, masterPlans.id))
            .where(and(eq(plans.userId, userId), inArray(plans.status, ['active', 'past_due'])))
            .limit(1);

        let limit: number | null = effectiveLimit(
            planRow?.featureOverrides as FeatureOverrides | null, 'assistantLimit', planRow?.assistantLimit ?? null);
        if (limit !== null) {
            const [org] = await db
                .select({ bonusAssistants: organisations.bonusAssistants })
                .from(organisations).where(eq(organisations.id, organisationId)).limit(1);
            limit += org?.bonusAssistants ?? 0;
        }

        // ⚠️ `archivedAt IS NULL` as well as isActive, matching the enrichment sweep's reasoning: an
        // archived assistant sits in its reinstate window still flagged active, so counting on
        // isActive alone would under-report the free seats and release nothing.
        const active = await db
            .select({ id: aiAssistants.id })
            .from(aiAssistants)
            .where(and(
                eq(aiAssistants.userId, userId),
                eq(aiAssistants.isActive, true),
                isNull(aiAssistants.archivedAt),
            ));

        const capacity = limit === null ? Number.MAX_SAFE_INTEGER : limit - active.length;
        if (capacity <= 0) return { resumed: [], remaining: limit === null ? null : 0 };

        // Newest first — the exact inverse of the downgrade handler, which sorts newest-first and
        // pauses from the end. Restoring in reverse order of pausing means the last one taken away
        // is the first given back.
        const paused = await db
            .select({ id: aiAssistants.id, name: aiAssistants.name })
            .from(aiAssistants)
            .where(and(
                eq(aiAssistants.userId, userId),
                eq(aiAssistants.provisioningStatus, 'paused_limit'),
                isNull(aiAssistants.archivedAt),
            ))
            .orderBy(desc(aiAssistants.createdAt))
            .limit(Math.min(capacity, 100));
        if (paused.length === 0) return { resumed: [], remaining: limit === null ? null : capacity };

        // `lifecycleStatus` is deliberately NOT set: the ai_assistants_lifecycle_sync trigger
        // derives it from (provisioningStatus, isActive), and writing it by hand here would give
        // the column two authors that can disagree.
        //
        // The marker is re-asserted inside the UPDATE — same guard resume-quota-paused.ts uses —
        // so a row that changed between the SELECT and here is not resurrected.
        const resumed = await db
            .update(aiAssistants)
            .set({ isActive: true, provisioningStatus: 'complete', updatedAt: new Date() })
            .where(and(
                inArray(aiAssistants.id, paused.map((a) => a.id)),
                eq(aiAssistants.provisioningStatus, 'paused_limit'),
            ))
            .returning({ id: aiAssistants.id, name: aiAssistants.name });

        return { resumed, remaining: limit === null ? null : capacity - resumed.length };
    } catch (err) {
        console.error('[release-paused-limit] could not release paused assistants:', err);
        return NOTHING;
    }
}
