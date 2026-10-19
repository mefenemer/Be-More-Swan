// netlify/functions/trial-sweep.ts
// Scheduled daily (netlify.toml). The free 14-day trial's three moments (src/utils/trial.ts):
//   1. three days before the end — `trial_ending_soon`, once (trials.reminder_sent_at);
//   2. on the end — the trial plan expires, running assistants pause, scheduled work is held, and
//      `trial_ended` says why. Nothing is deleted;
//   3. backstop — a workspace that subscribed after its trial ended is switched back on by the
//      plan-row writers (afterPaidPlanStarted) the moment it pays; if that was ever missed, here.
//
// ⚠️ Netlify fires scheduled functions ONLY on the production deploy (staging is a branch deploy).

import { and, eq, inArray, isNotNull, isNull, notInArray } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { organisations, plans, trials, users } from '../../db/schema';
import { planPriceVars } from '../../src/utils/plan-price-tokens';
import { FREE_PLAN_TYPES } from '../../src/config/beta-plan';
import { sendTemplatedEmail } from '../../src/utils/email';
import { dueTrials, endTrialFor, resumeAfterTrialConversion, trialsNeedingReminder } from '../../src/utils/trial';

type Db = ReturnType<typeof getDb>;

async function emailVars(db: Db, trial: typeof trials.$inferSelect, baseUrl: string) {
    const [owner] = trial.userId
        ? await db.select({ email: users.email, firstName: users.firstName }).from(users).where(eq(users.id, trial.userId)).limit(1)
        : [];
    const [org] = await db.select({ name: organisations.name }).from(organisations).where(eq(organisations.id, trial.organisationId)).limit(1);
    // The plan prices the email quotes come from master data (Admin ▸ Master Data ▸ Plans), so a
    // price change reaches this email with no template edit — "£79" outlived the move to £69 here.
    const prices = await planPriceVars(db);
    return {
        to: owner?.email ?? null,
        vars: {
            user: { first_name: owner?.firstName ?? '' },
            workspace: { name: org?.name ?? '' },
            trial: { ends_on: trial.endsAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' }) },
            plans: prices,
            link: { action_url: `${baseUrl}/workspace.html?action=select-plan` },
        },
    };
}

export default withLambda(async () => {
    const db = getDb();
    const baseUrl = process.env.BASE_URL || 'https://bemoreswan.com';
    const now = new Date();
    const result = { reminded: 0, ended: 0, alreadyConverted: 0, resumed: 0, emailed: 0, errors: 0 };

    try {
        for (const trial of await trialsNeedingReminder(db, 3, now)) {
            try {
                // Claim first, so a re-run (or a slow send) never emails twice.
                const claimed = await db.update(trials).set({ reminderSentAt: now, updatedAt: now })
                    .where(and(eq(trials.id, trial.id), isNull(trials.reminderSentAt))).returning({ id: trials.id });
                if (!claimed.length) continue;
                const { to, vars } = await emailVars(db, trial, baseUrl);
                if (to && await sendTemplatedEmail({ triggerKey: 'trial_ending_soon', to, vars })) result.emailed++;
                result.reminded++;
            } catch (err) {
                result.errors++;
                console.error('[trial-sweep] reminder failed for org', trial.organisationId, err);
            }
        }

        for (const trial of await dueTrials(db, now)) {
            try {
                const outcome = await endTrialFor(db, trial.organisationId, now);
                if (outcome === 'converted') { result.alreadyConverted++; continue; }
                if (outcome !== 'ended') continue;
                result.ended++;
                const { to, vars } = await emailVars(db, trial, baseUrl);
                if (to && await sendTemplatedEmail({ triggerKey: 'trial_ended', to, vars })) result.emailed++;
            } catch (err) {
                result.errors++;
                console.error('[trial-sweep] could not end trial for org', trial.organisationId, err);
            }
        }

        // Backstop: ended, not yet marked converted, but now holding a paid plan.
        const waiting = await db.select({ organisationId: trials.organisationId }).from(trials)
            .where(and(isNotNull(trials.endedAt), isNull(trials.convertedAt)));
        if (waiting.length) {
            const paid = await db.select({ organisationId: plans.organisationId }).from(plans).where(and(
                inArray(plans.organisationId, waiting.map((w) => w.organisationId)),
                notInArray(plans.planType, [...FREE_PLAN_TYPES]), inArray(plans.status, ['active', 'past_due']),
            ));
            for (const { organisationId } of paid) if (await resumeAfterTrialConversion(db, organisationId, now)) result.resumed++;
        }
    } catch (err) {
        // A missing trials table (migration not applied) lands here — log it, never throw.
        console.error('[trial-sweep] failed', err);
        result.errors++;
    }

    console.log('[trial-sweep]', JSON.stringify(result));
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
});
