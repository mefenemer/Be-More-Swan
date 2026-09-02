// netlify/functions/check-optimiser-health.ts
// Is the paid-campaign sweep still running? Alerts a human when it is not.
//
// Scheduled at 09:20 UTC — deliberately a different schedule from optimise-paid-campaigns (06:40),
// so a fault in one function's own schedule entry does not silently take the other with it.
//
// ── What this covers, and what it does not ──────────────────────────────────────────────────────
// ⚠️ CORRELATED FAILURE, stated up front: this runs on the same Netlify scheduler as the thing it
// watches. If that whole scheduler is down, so is this. It catches the LIKELY failures — an
// exception in the sweep, a bad deploy, a schedule entry that stopped matching a filename — and not
// the platform-wide one.
//
// The uncorrelated watchers are elsewhere, and all three exist on purpose:
//   • the staging-crons GitHub workflow — separate infrastructure, survives a Netlify outage
//   • `campaigns.ts` `list` — driven by user traffic, cannot fail the way a scheduler fails
// See src/utils/optimiser-health.ts. Presenting any one of them as "the" uptime check would be a
// false guarantee; three imperfect watchers with different failure modes is the honest best.
//
// ── It alerts the OPERATOR, not the customer ────────────────────────────────────────────────────
// A dead optimiser is our failure, not theirs. The customer already gets the consequence — their
// campaigns halt themselves — and telling them "our monitoring stopped" adds alarm without an
// action they can take. The founder alert is the one that leads somewhere.
//
// POST-guarded like the other pokes so an external monitor can call it too.

import { and, count, eq, inArray, isNotNull } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { campaigns } from '../../db/schema';
import { CONFIG_KEYS, getPlatformConfig, setPlatformConfig } from '../../src/utils/platform-config';
import { assessOptimiserHealth, readLastRunAt } from '../../src/utils/optimiser-health';
import { sendEmail } from '../../src/utils/email';
import { withLambda } from '@netlify/aws-lambda-compat';

const FOUNDER_EMAIL = process.env.FOUNDER_ALERT_EMAIL || 'hello@bemoreswan.com';

/**
 * Don't re-send the same alarm every run.
 *
 * ⚠️ 6h, not 24h. An alert that repeats hourly gets filtered; one that repeats daily lets a whole
 * working day pass on a second look. Six hours means an unattended incident resurfaces within a
 * working day without ever becoming noise.
 */
const ALERT_COOLDOWN_HOURS = 6;

export interface HealthCheckResult {
    state: string;
    hoursSince: number | null;
    liveCampaigns: number;
    alerted: boolean;
}

export async function runOptimiserHealthCheck(): Promise<HealthCheckResult> {
    const db = getDb();
    const now = new Date();

    // The denominator that decides whether silence is a fault or the correct answer.
    const [live] = await db.select({ n: count() })
        .from(campaigns)
        .where(and(
            eq(campaigns.mode, 'paid'),
            inArray(campaigns.status, ['active', 'throttled']),
            isNotNull(campaigns.externalCampaignId),
        ));
    const liveCampaigns = Number(live?.n ?? 0);

    const lastRunAt = readLastRunAt(await getPlatformConfig(CONFIG_KEYS.PAID_OPTIMISER_LAST_RUN));
    const health = assessOptimiserHealth(lastRunAt, liveCampaigns, now);

    if (!health.actionable) {
        return { state: health.state, hoursSince: health.hoursSince, liveCampaigns, alerted: false };
    }

    // Cooldown, so an ongoing incident does not send an email every scheduled run.
    const lastAlert = readLastRunAt(await getPlatformConfig(CONFIG_KEYS.PAID_OPTIMISER_LAST_ALERT));
    const sinceAlert = lastAlert ? (now.getTime() - lastAlert.getTime()) / 3_600_000 : Infinity;
    if (sinceAlert < ALERT_COOLDOWN_HOURS) {
        return { state: health.state, hoursSince: health.hoursSince, liveCampaigns, alerted: false };
    }

    try {
        await sendEmail({
            to: FOUNDER_EMAIL,
            subject: `[Be More Swan] Paid optimiser ${health.state} — ${liveCampaigns} live campaign${liveCampaigns === 1 ? '' : 's'}`,
            // Deliberately plain and specific. An ops alert is read on a phone, at speed, by
            // someone deciding whether to stop what they are doing.
            html: `<p>${health.message}</p>
<ul>
  <li>State: <strong>${health.state}</strong></li>
  <li>Last run: ${lastRunAt ? lastRunAt.toISOString() : 'never'}</li>
  <li>Live paid campaigns: ${liveCampaigns}</li>
</ul>
<p>The sweep is <code>optimise-paid-campaigns</code> (06:40 UTC). Campaigns halt themselves after
${Math.floor(health.hoursSince ?? 0)}h without a check, so customers are protected — but their ads
stop, and nothing is applying the fatigue or cost rules until this is running again.</p>`,
            text: `${health.message}\n\nState: ${health.state}\nLast run: ${lastRunAt ? lastRunAt.toISOString() : 'never'}\nLive paid campaigns: ${liveCampaigns}`,
        });
        await setPlatformConfig(CONFIG_KEYS.PAID_OPTIMISER_LAST_ALERT, { at: now.toISOString(), state: health.state });
        return { state: health.state, hoursSince: health.hoursSince, liveCampaigns, alerted: true };
    } catch (err) {
        // ⚠️ Swallowed, but LOUDLY. A failed alert must not crash the check — but it must also not
        // look like a clean run, or the next reader concludes the optimiser is fine.
        console.error('[check-optimiser-health] ALERT SEND FAILED — the optimiser is unhealthy and nobody has been told', err);
        return { state: health.state, hoursSince: health.hoursSince, liveCampaigns, alerted: false };
    }
}

export default withLambda(async () => ({
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(await runOptimiserHealthCheck()),
}));
