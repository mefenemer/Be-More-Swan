// src/utils/restore-after-new-plan.ts
// A new paid plan has started: bring back the assistants the old plan's end or a failed payment paused.
// Kept apart from release-paused-limit.ts on purpose: that file only ever releases `paused_limit`
// (tests/assistant-pause-defects.test.ts), and `paused_payment` belongs to billing. This is the one
// billing moment that may clear it — a NEW paid plan exists — and it hands the result to the
// slot release so the new plan's limit still applies.

import { and, eq, isNull } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants } from '../../db/schema';
import { releasePausedLimit, type ReleaseResult } from './release-paused-limit';

type Db = ReturnType<typeof getDb>;
/**
 * A new paid plan has just started (checkout.session.completed / payment_intent.succeeded in
 * stripe-webhook.ts). Switch back on what the old plan's end or a failed payment paused.
 *
 * ── Why ──────────────────────────────────────────────────────────────────────────────────────
 * `paused_payment` was only ever cleared by a successful payment while a plan was past_due, and
 * `paused_limit` only by archiving or a change to the SAME subscription. A customer who cancelled and
 * later bought a new subscription got an active plan and kept every assistant paused, with nothing to
 * release them (staging workspace 58, 2026-10-25: Felix paused_limit since July, Mira and Ember
 * paused_payment, on an active 10-seat plan).
 *
 * Payment-paused assistants become slot-paused first, so the new plan's limit still applies: those it
 * has room for come back (newest first, via releasePausedLimit); any it can't fit stay paused for slots,
 * which is then true. Only these two markers move — never one the user paused themselves.
 *
 * Never throws: it runs inside the Stripe webhook, after the plan row is written.
 */
export async function restoreAfterNewPlan(db: Db, userId: number, organisationId: number): Promise<ReleaseResult | null> {
    try {
        await db.update(aiAssistants)
            .set({ provisioningStatus: 'paused_limit', updatedAt: new Date() })
            .where(and(
                eq(aiAssistants.userId, userId),
                eq(aiAssistants.organisationId, organisationId),
                eq(aiAssistants.provisioningStatus, 'paused_payment'),
                isNull(aiAssistants.archivedAt),
            ));
        return await releasePausedLimit(db, userId, organisationId);
    } catch (err) {
        console.error('[restore-after-new-plan] restore after a new plan failed (non-blocking):', err);
        return null;
    }
}
