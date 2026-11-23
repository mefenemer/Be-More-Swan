// netlify/functions/partner-weekly-nudge.ts
// The Monday summary from each partner's Partner Assistant (docs/partner-onboarding-plan.md §3.5, Phase 3):
// last week's numbers and ONE suggested step, as a bell notification and an email whose button opens their
// Partner page with that question typed in (?ask=<key>). Rules (owner decision D6) in
// src/utils/partner-weekly-nudge.ts: approved partners with an account, not turned off, first 8 weeks or
// any week with activity, once per ISO week. No model call.
//
// Scheduled in netlify.toml (production only — Netlify never fires schedules on a branch deploy). Staging
// is poked through run-partner-weekly-nudge.ts from staging-crons.yml.
//
// Idempotent: each partner's week is CLAIMED (onboarding.last_nudge_week) before anything is sent, so a
// second run in the same week — or two at once — sends nothing more. A send that fails after the claim is
// logged and not retried that week (a missed summary beats a double one).

import { eq, sql } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { partners, users } from '../../db/schema';
import { partnerHubSummary } from '../../src/utils/partner-ops';
import { buildChecklist } from '../../src/utils/partner-onboarding';
import { buildNudge, isoWeek, nudgeDecision, type NudgeMarks, type WeekStats } from '../../src/utils/partner-weekly-nudge';
import { createNotification } from '../../src/utils/notify';
import { sendTemplatedEmail } from '../../src/utils/email';
import { PARTNER_TERMS_VERSION } from '../../src/config/partner-terms';

const baseUrl = () => (process.env.BASE_URL || 'https://bemoreswan.com').replace(/\/$/, '');

export async function sendWeeklyPartnerNudges(now = new Date()): Promise<{ sent: number; skipped: Record<string, number> }> {
    const db = getDb();
    const week = isoWeek(now);
    const rows = await db.select().from(partners).where(eq(partners.status, 'approved'));
    let sent = 0;
    const skipped: Record<string, number> = {};
    for (const p of rows) {
        try {
            const marks = (p.onboarding || {}) as NudgeMarks & Record<string, string>;
            const { stats } = await partnerHubSummary(db, p.id);
            const s = (stats || {}) as WeekStats;
            const decision = nudgeDecision({ status: p.status, userId: p.userId, marks, stats: s, now });
            if (!decision.send) { skipped[decision.reason] = (skipped[decision.reason] || 0) + 1; continue; }

            // Claim this partner's week first: only one run can win it.
            const claimed = await db.update(partners).set({
                onboarding: sql`${partners.onboarding} || jsonb_build_object('last_nudge_week', ${week}::text, 'nudge_started_at', COALESCE(${partners.onboarding}->>'nudge_started_at', ${now.toISOString()}::text))`,
            }).where(sql`${partners.id} = ${p.id} AND (${partners.onboarding}->>'last_nudge_week') IS DISTINCT FROM ${week}`).returning({ id: partners.id });
            if (!claimed.length) { skipped.already_sent = (skipped.already_sent || 0) + 1; continue; }

            const [u] = await db.select({ email: users.email, firstName: users.firstName }).from(users).where(eq(users.id, p.userId!)).limit(1);
            const steps = buildChecklist({
                termsAccepted: p.termsVersion === PARTNER_TERMS_VERSION, payoutSet: !!(p.payoutDetailsConfirmedAt && p.payoutDisplay),
                marks, stats: s, invitePageLive: !!p.inviteProfile,
            });
            const n = buildNudge({ firstName: u?.firstName ?? null, stats: s, steps });
            const vars = { partner: { title: n.title, summary: n.summary, action: n.action.line } };
            await createNotification(db, 'partner_weekly_summary', { userId: p.userId!, context: vars, metadata: { action: 'partner_page' } })
                .catch((err) => console.error('[partner-weekly-nudge] notification failed', p.id, err));
            if (u?.email) {
                await sendTemplatedEmail({ triggerKey: 'partner_weekly_summary', to: u.email, vars: {
                    ...vars, user: { first_name: u.firstName || '' },
                    link: { action_url: `${baseUrl()}/workspace.html?view=partner&ask=${n.action.key}` },
                } }).catch((err) => console.error('[partner-weekly-nudge] email failed', p.id, err));
            }
            sent++;
        } catch (err) {
            console.error('[partner-weekly-nudge] partner failed (others continue)', p.id, err);
            skipped.error = (skipped.error || 0) + 1;
        }
    }
    return { sent, skipped };
}

export default withLambda(async () => {
    try {
        const result = await sendWeeklyPartnerNudges();
        console.log('[partner-weekly-nudge]', result);
        return { statusCode: 200, body: JSON.stringify({ ok: true, ...result }) };
    } catch (err) {
        console.error('[partner-weekly-nudge] failed', err);
        return { statusCode: 500, body: JSON.stringify({ ok: false }) };
    }
});
