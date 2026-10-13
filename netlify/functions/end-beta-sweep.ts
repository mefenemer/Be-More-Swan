// netlify/functions/end-beta-sweep.ts
// Scheduled daily (netlify.toml). Ends each beta on the date an admin set for it — and ONLY a beta
// whose notice an admin actually sent (endBetaFor refuses otherwise). It never emails anyone about an
// upcoming end; that is the admin's call. It does send `beta_ended` on the day, so the customer
// learns why their assistants stopped.
//
// Also the backstop for the resume: a workspace that subscribed after its beta ended is switched back
// on by the plan-row writers (create-subscription / stripe-webhook) the moment it pays. If that hook
// was ever missed, this catches it within a day.

import { and, eq, inArray, isNotNull, isNull, lte, ne } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { betaEndings, plans } from '../../db/schema';
import { sendTemplatedEmail } from '../../src/utils/email';
import { BETA_PLAN_TYPE } from '../../src/utils/beta-testers';
import { betaOfferFor, endBetaFor, loadBetaWorkspaces, loadOfferableTiers, resumeAfterBetaConversion } from '../../src/utils/beta-ending';

export default withLambda(async () => {
    const db = getDb();
    const baseUrl = process.env.BASE_URL || 'https://bemoreswan.com';
    // The end date is a UK calendar day: a beta "ending on 13 November" ends that morning, UK time.
    const todayUk = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
    const result = { ended: 0, alreadyConverted: 0, resumed: 0, emailed: 0, errors: 0 };

    try {
        const due = await db.select({ organisationId: betaEndings.organisationId }).from(betaEndings)
            .where(and(lte(betaEndings.endsOn, todayUk), isNull(betaEndings.endedAt), isNotNull(betaEndings.noticeSentAt)));

        if (due.length) {
            const [workspaces, tiers] = await Promise.all([loadBetaWorkspaces(db), loadOfferableTiers(db)]);
            for (const { organisationId } of due) {
                try {
                    const outcome = await endBetaFor(db, organisationId);
                    if (outcome === 'converted') { result.alreadyConverted++; continue; }
                    if (outcome !== 'ended') continue;
                    result.ended++;
                    const ws = workspaces.find((w) => w.organisationId === organisationId);
                    const offer = ws ? await betaOfferFor(db, ws, tiers, baseUrl) : null;
                    if (ws?.ownerEmail && offer) {
                        const sent = await sendTemplatedEmail({ triggerKey: 'beta_ended', to: ws.ownerEmail, vars: offer.vars });
                        if (sent) result.emailed++;
                    }
                } catch (err) {
                    result.errors++;
                    console.error('[end-beta-sweep] could not end beta for org', organisationId, err);
                }
            }
        }

        // Backstop: ended, not yet marked converted, but now holding a paid plan.
        const waiting = await db.select({ organisationId: betaEndings.organisationId }).from(betaEndings)
            .where(and(isNotNull(betaEndings.endedAt), isNull(betaEndings.convertedAt)));
        if (waiting.length) {
            const paid = await db.select({ organisationId: plans.organisationId }).from(plans).where(and(
                inArray(plans.organisationId, waiting.map((w) => w.organisationId)),
                ne(plans.planType, BETA_PLAN_TYPE), inArray(plans.status, ['active', 'past_due']),
            ));
            for (const { organisationId } of paid) if (await resumeAfterBetaConversion(db, organisationId)) result.resumed++;
        }
    } catch (err) {
        // A missing beta_endings table (migration not applied) lands here — log it, never throw.
        console.error('[end-beta-sweep] failed', err);
        result.errors++;
    }

    console.log('[end-beta-sweep]', JSON.stringify(result));
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
});
