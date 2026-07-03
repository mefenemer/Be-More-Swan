// netlify/functions/get-onboarding-progress.ts
// US1.1 — Dynamic onboarding progress widget. Returns the 3 setup steps with
// done-flags derived from real rows (AC1.1.2: a step auto-checks once its row
// exists — brand asset / connection / assistant). When all 3 are done, flips the
// permanent onboarding_completed flag so the widget never renders again (AC1.1.3).

import { Handler } from '@netlify/functions';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { organisations, systemConnections, aiAssistants, notifications, onboardingDrafts } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

// Remove the onboarding nudge notifications (welcome + the two setup reminders) for one
// user. Idempotent and concurrency-safe: DELETE … RETURNING serialises on the rows, so
// only the first of any concurrent calls gets a non-zero count — used to fire the
// completion celebration exactly once. Best-effort: never throws.
async function clearOnboardingNudges(db: ReturnType<typeof getDb>, userId: number): Promise<number> {
    try {
        const deleted = await db.delete(notifications).where(and(
            eq(notifications.userId, userId),
            inArray(notifications.type, ['welcome', 'onboarding_prompt', 'onboarding_incomplete']),
        )).returning({ id: notifications.id });
        return deleted.length;
    } catch (err) {
        console.warn('[get-onboarding-progress] clearOnboardingNudges failed (non-blocking):', err);
        return 0;
    }
}

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const orgId = ctx.organisationId;

    const [org] = await db.select({
        onboardingCompleted: organisations.onboardingCompleted,
        industry:            organisations.industry,
        businessDescription: organisations.businessDescription,
        targetAudience:      organisations.targetAudience,
    }).from(organisations).where(eq(organisations.id, orgId)).limit(1);

    // Step 1 ticks once the core business-profile fields are filled in (Business
    // Information page). The other steps auto-check once their backing rows exist.
    const businessProfile = Boolean(org?.industry && org?.businessDescription && org?.targetAudience);

    const exists = async (rows: Promise<{ id: number | string }[]>) => (await rows).length > 0;
    const [connection, firstAssistant, draftInProgress, activeAssistant] = await Promise.all([
        exists(db.select({ id: systemConnections.id }).from(systemConnections).where(eq(systemConnections.organisationId, orgId)).limit(1)),
        exists(db.select({ id: aiAssistants.id }).from(aiAssistants).where(eq(aiAssistants.organisationId, orgId)).limit(1)),
        // An onboarding draft only exists while the wizard is still in progress — it is
        // removed once the assistant is provisioned, so "no draft" = the form is finished.
        exists(db.select({ id: onboardingDrafts.id }).from(onboardingDrafts).where(eq(onboardingDrafts.organisationId, orgId)).limit(1)),
        // Kicked off = an assistant has been activated and is working.
        exists(db.select({ id: aiAssistants.id }).from(aiAssistants).where(and(
            eq(aiAssistants.organisationId, orgId),
            eq(aiAssistants.provisioningStatus, 'complete'),
            eq(aiAssistants.isActive, true),
        )).limit(1)),
    ]);

    // The onboarding form is complete once an assistant exists and no draft is still open.
    const onboardAssistant = firstAssistant && !draftInProgress;

    // AC1.1.1: the core steps. Labels mirror the welcome email (verify.ts) so the in-app
    // checklist reads identically to what users receive. The two trailing steps
    // (onboard_assistant, kick_off) are display-only — they extend the journey to a working
    // assistant but do NOT gate the onboarding_completed flip (which stays the original 3).
    const steps = [
        { key: 'business_profile',  label: 'Complete your business profile', done: businessProfile },
        { key: 'first_assistant',   label: 'Choose your assistant',          done: firstAssistant },
        { key: 'connection',        label: 'Connect your tools',             done: connection },
        { key: 'onboard_assistant', label: 'Onboard your assistant',         done: onboardAssistant },
        { key: 'kick_off',          label: 'Kick Off Meeting',               done: activeAssistant },
    ];

    // Core completion (unchanged): business profile + assistant + connection. Drives the
    // permanent onboarding_completed flip and its one-time celebration side-effects.
    const coreAllDone = businessProfile && firstAssistant && connection;

    // Already finished — widget must never render again. Clear any lingering onboarding
    // nudges for THIS user every time (idempotent); if we actually cleared some, signal
    // justCompleted so the UI fires the celebration once. Steps are still returned (with
    // live flags) so the extended checklist can reflect onboarding/kick-off state.
    if (org?.onboardingCompleted) {
        const cleared = await clearOnboardingNudges(db, ctx.userId);
        return json(200, { onboardingCompleted: true, allDone: true, justCompleted: cleared > 0, steps });
    }

    let justCompleted = false;
    if (coreAllDone) {
        // Atomic flip: only the request that actually transitions the flag (false→true)
        // runs the one-time side effects below, so concurrent calls can't double-fire.
        const flipped = await db.update(organisations)
            .set({ onboardingCompleted: true })
            .where(and(eq(organisations.id, orgId), eq(organisations.onboardingCompleted, false)))
            .returning({ id: organisations.id });
        if (flipped.length) {
            justCompleted = true; // AC1.1.3 — UI fires the celebration
            // Replace the onboarding prompts with a single "Setup complete" notification.
            try {
                await clearOnboardingNudges(db, ctx.userId);
                await db.insert(notifications).values({
                    userId: ctx.userId,
                    type: 'setup_complete',
                    title: 'Setup complete 🎉',
                    message: 'Your business profile and assistant are ready — your assistant is now working for you.',
                });
            } catch (notifErr) {
                console.warn('[get-onboarding-progress] setup-complete notification swap failed (non-blocking):', notifErr);
            }
        }
    }

    return json(200, { onboardingCompleted: coreAllDone, allDone: coreAllDone, justCompleted, steps });
};
