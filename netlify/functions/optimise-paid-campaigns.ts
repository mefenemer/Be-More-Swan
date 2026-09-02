// netlify/functions/optimise-paid-campaigns.ts
// The daily pass over live PAID campaigns. US4 of the brief — the kill switch, actually wired.
//
//   for each live paid campaign
//     1. HEARTBEAT   — have we been able to check on this recently? If not, stop it.
//     2. CONTROL     — can we still reach the ad account? If not, stop it.
//     3. METRICS     — pull yesterday's numbers, store them.
//     4. OPTIMISE    — pause fatigued or over-priced variants. Never start anything.
//     5. STAMP       — record that we looked, which is what keeps step 1 quiet.
//   then one digest notification per organisation.
//
// The decisions live in src/utils/campaign-optimiser.ts and are unit-tested there. This file is
// the I/O: fetching, storing, applying, and telling the user.
//
// ── Why the heartbeat is checked HERE, by the thing it is watching ──────────────────────────────
// It looks circular — a dead cron cannot notice it is dead. It is not useless, and the case it
// catches is the common one: the cron stops for a day or three (a deploy, a Netlify incident, the
// scheduler dropping ticks) and then RESUMES. Without this check it would resume as though nothing
// had happened, having left campaigns unwatched and spending through the gap. With it, the first
// run back stops anything that went unwatched and says so.
//
// ⚠️ WHAT IT DOES NOT COVER: a cron that never comes back at all. Nothing inside this file can fix
// that, and pretending otherwise would be the dangerous half-measure. The honest mitigations are
// external — an uptime check on the run marker, or the same assessHeartbeat() call on the read path
// so a user opening the Campaigns tab triggers it. Neither is built yet.
//
// ── In production this currently does nothing, correctly ────────────────────────────────────────
// `linkedInAdapter()` throws outside development (Development Tier, five-account edit cap). So in
// production there are no live paid campaigns to sweep — nothing can be staged or launched either —
// and this function logs that it found none. That is the honest state, not a bug to code around.

import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import {
    adVariantMetrics, adVariants, aiAssistants, campaignBudgets, campaigns, userOrganisations,
} from '../../db/schema';
import { linkedInAdapter } from '../../src/utils/ad-networks/registry';
import { getAdsConnection, getAdsToken, assessAdsReadiness } from '../../src/utils/linkedin-ads-connection';
import {
    assessHeartbeat, optimise, type DailyMetric, type VariantWindow,
} from '../../src/utils/campaign-optimiser';
import { FATIGUE_WINDOW_DAYS } from '../../src/config/ad-networks';
import { createNotification } from '../../src/utils/notify';
import { CONFIG_KEYS, isGlobalAiDisabled, setPlatformConfig } from '../../src/utils/platform-config';
import { withLambda } from '@netlify/aws-lambda-compat';

/** Campaigns examined per run. A cap so one enormous workspace cannot starve the rest. */
const BATCH = 50;

interface OrgNotice {
    organisationId: number;
    assistantId: number | null;
    paused: string[];
    halted: { name: string; reason: string }[];
}

export interface PaidSweepResult {
    examined: number;
    paused: number;
    halted: number;
    skipped?: string;
}

/**
 * The sweep itself, exported so the staging poke (run-paid-optimiser.ts) drives the SAME code.
 *
 * ⚠️ One implementation, two callers. If staging ran a copy of this logic, the thing being tested
 * on staging would not be the thing running in production — which is the entire point of having a
 * staging poke at all.
 */
export async function runPaidOptimiserSweep(): Promise<PaidSweepResult> {
    const db = getDb();

    // Same global switch every other autonomous run respects.
    if (await isGlobalAiDisabled()) {
        return { examined: 0, paused: 0, halted: 0, skipped: 'ai_disabled' };
    }

    const now = new Date();
    const live = await db.select({
        id: campaigns.id,
        organisationId: campaigns.organisationId,
        aiAssistantId: campaigns.aiAssistantId,
        objective: campaigns.objective,
        status: campaigns.status,
        externalCampaignId: campaigns.externalCampaignId,
        optimiserLastRunAt: campaigns.optimiserLastRunAt,
        controlState: campaigns.controlState,
    }).from(campaigns)
        .where(and(
            eq(campaigns.mode, 'paid'),
            inArray(campaigns.status, ['active', 'throttled']),
            isNotNull(campaigns.externalCampaignId),
        ))
        .limit(BATCH);

    const notices = new Map<number, OrgNotice>();
    const notice = (c: typeof live[number]) => {
        let n = notices.get(c.organisationId);
        if (!n) {
            n = { organisationId: c.organisationId, assistantId: c.aiAssistantId, paused: [], halted: [] };
            notices.set(c.organisationId, n);
        }
        return n;
    };

    let examined = 0;
    let pausedTotal = 0;
    let haltedTotal = 0;

    for (const c of live) {
        try {
            // ── Step 1: the heartbeat. Checked BEFORE anything else, because if we have not been
            // able to look at this campaign it should not keep running while we work out why.
            const beat = assessHeartbeat(c.optimiserLastRunAt, now);
            if (beat.stale) {
                await haltCampaign(db, c, beat.message!, notice(c));
                haltedTotal++;
                continue;
            }

            const readiness = assessAdsReadiness(await getAdsConnection(db, c.organisationId));
            if (!readiness.ready) {
                await haltCampaign(db, c, 'The LinkedIn advertising connection is no longer usable.', notice(c));
                haltedTotal++;
                continue;
            }
            const token = await getAdsToken(db, c.organisationId);
            if (!token) {
                await haltCampaign(db, c, 'The LinkedIn advertising connection needs reconnecting.', notice(c));
                haltedTotal++;
                continue;
            }

            let adapter;
            try {
                adapter = linkedInAdapter({
                    accessToken: token,
                    accountUrn: readiness.connection.selectedAccountUrn!,
                    campaignGroupUrn: '',
                    currencyCode: 'GBP',
                });
            } catch {
                // Production: Development Tier is dev-only. There should be no live paid campaigns
                // here at all, so this is logged and skipped rather than treated as a halt — a halt
                // would need a network call we cannot make either.
                console.warn('[optimise-paid] no adapter available; skipping', { campaignId: c.id });
                continue;
            }

            // ── Step 2: control. A campaign we cannot stop must not keep running.
            const control = await adapter.checkControl(c.externalCampaignId!);
            if (!control.ok) {
                await db.update(campaigns).set({
                    controlState: 'lost', controlDetail: control.detail ?? null,
                    controlCheckedAt: now, updatedAt: now,
                }).where(eq(campaigns.id, c.id));
                await haltCampaign(db, c,
                    'We could not reach your LinkedIn ad account, so we stopped the campaign rather than let it keep spending unwatched.',
                    notice(c), adapter);
                haltedTotal++;
                continue;
            }

            const variants = await db.select({
                id: adVariants.id,
                externalVariantId: adVariants.externalVariantId,
                status: adVariants.status,
            }).from(adVariants)
                .where(and(eq(adVariants.campaignId, c.id), eq(adVariants.status, 'active')));
            const withExternal = variants.filter((v) => v.externalVariantId);
            if (withExternal.length === 0) {
                await stamp(db, c.id, now);
                examined++;
                continue;
            }

            // ── Step 3: metrics. Stored, so the evidence behind a pause survives for the user to
            // question, and so a 7-day window costs one fetch a day rather than seven.
            const rows = await adapter.fetchMetrics(
                withExternal.map((v) => v.externalVariantId!),
                FATIGUE_WINDOW_DAYS + 1,
            );
            const byExternal = new Map(withExternal.map((v) => [v.externalVariantId!, v.id]));
            for (const r of rows) {
                const variantId = byExternal.get(r.externalVariantId);
                if (!variantId) continue;
                // ⚠️ NaN spend means the ad account is not in GBP. stage_paid refuses those, so
                // this should be unreachable — but storing NaN would poison every cost figure
                // downstream, so it is skipped and logged rather than coerced to zero.
                if (!Number.isFinite(r.spendGbp)) {
                    console.warn('[optimise-paid] non-GBP spend on a campaign that should be GBP', { campaignId: c.id });
                    continue;
                }
                await db.insert(adVariantMetrics).values({
                    organisationId: c.organisationId,
                    variantId,
                    day: r.day,
                    impressions: r.impressions,
                    clicks: r.clicks,
                    spendGbp: String(r.spendGbp),
                    reportedConversions: r.reportedConversions,
                }).onConflictDoUpdate({
                    // One row per variant per day. Appending instead would double every
                    // denominator and halve every rate.
                    target: [adVariantMetrics.variantId, adVariantMetrics.day],
                    set: {
                        impressions: r.impressions, clicks: r.clicks,
                        spendGbp: String(r.spendGbp), reportedConversions: r.reportedConversions,
                        fetchedAt: now,
                    },
                });
            }

            // ── Step 4: optimise, from what we have STORED rather than what we just fetched, so a
            // partial fetch cannot make a variant look like it collapsed.
            // ⚠️ THE LINE THAT TURNS THE COST RULE ON. It passed a hard-coded null from the day
            // this cron was written, because there was no column to read. Null still means "no
            // ceiling — never pause on cost", and that is still most campaigns.
            const [budget] = await db.select({ maxCostPerOutcomeGbp: campaignBudgets.maxCostPerOutcomeGbp })
                .from(campaignBudgets).where(eq(campaignBudgets.campaignId, c.id)).limit(1);
            const ceiling = budget?.maxCostPerOutcomeGbp != null ? Number(budget.maxCostPerOutcomeGbp) : null;

            const windows: VariantWindow[] = [];
            for (const v of withExternal) {
                const stored = await db.select({
                    day: adVariantMetrics.day,
                    impressions: adVariantMetrics.impressions,
                    clicks: adVariantMetrics.clicks,
                    spendGbp: adVariantMetrics.spendGbp,
                    reportedConversions: adVariantMetrics.reportedConversions,
                }).from(adVariantMetrics)
                    .where(eq(adVariantMetrics.variantId, v.id))
                    .orderBy(adVariantMetrics.day);
                windows.push({
                    variantId: v.id,
                    externalVariantId: v.externalVariantId!,
                    status: 'active',
                    days: stored.map((d): DailyMetric => ({
                        day: String(d.day),
                        impressions: d.impressions,
                        clicks: d.clicks,
                        spendGbp: Number(d.spendGbp),
                        // ⚠️ OUR attributed conversions would be the better signal, but they are
                        // not joined per-variant yet. The network's own count is used and named as
                        // such; when the attribution join lands this is the line to change.
                        conversions: d.reportedConversions,
                    })),
                });
            }

            const result = optimise({
                variants: windows,
                // The CUSTOMER's ceiling, or null. Never the daily budget: that would be the agent
                // inventing what a lead is worth, which is a commercial judgement it has no
                // standing to make.
                maxCostPerOutcomeGbp: ceiling,
                maxActionsPerDay: 3,
                actionsTakenToday: 0,
            });

            // ⚠️ A decision that would stop the whole campaign is NOT applied here. It is a
            // judgement about the customer's business — sometimes right, sometimes catastrophic —
            // so the optimiser reports it and a human decides.
            const toPause = result.wouldStopCampaign ? [] : result.pauses;
            for (const p of toPause) {
                await adapter.pauseVariant(p.externalVariantId, p.reason);
                await db.update(adVariants).set({
                    status: 'paused', pauseReason: p.reason, updatedAt: now,
                }).where(eq(adVariants.id, p.variantId));
                notice(c).paused.push(`an ad on "${c.objective.slice(0, 60)}" — ${p.explanation}`);
                pausedTotal++;
            }

            await stamp(db, c.id, now);
            examined++;
        } catch (err) {
            // One campaign's failure must not abandon the rest — including the ones that need
            // stopping.
            console.error('[optimise-paid] campaign failed', { campaignId: c.id }, err);
        }
    }

    await notifyOwners(db, notices);
    await setPlatformConfig(CONFIG_KEYS.PAID_OPTIMISER_LAST_RUN, { at: now.toISOString(), examined, pausedTotal, haltedTotal });

    return { examined, paused: pausedTotal, halted: haltedTotal };
}

export default withLambda(async () => ({
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(await runPaidOptimiserSweep()),
}));

/** Record that we looked. This is what keeps the heartbeat quiet on the next run. */
async function stamp(db: any, campaignId: number, now: Date): Promise<void> {
    await db.update(campaigns)
        .set({ optimiserLastRunAt: now, updatedAt: now })
        .where(eq(campaigns.id, campaignId));
}

/**
 * Stop a campaign, on the network first where we still can.
 *
 * ⚠️ The local write happens even when the network pause FAILS, and the two are reported
 * differently. A campaign we could not stop is the "control lost" case: our records must say it is
 * halted (so nothing here keeps trying to optimise it) while the user is told plainly that money
 * may still be moving. Silently recording a halt we did not achieve would be the worst of both.
 */
async function haltCampaign(
    db: any,
    c: { id: number; objective: string; externalCampaignId: string | null },
    reason: string,
    into: OrgNotice,
    adapter?: { pauseCampaign(id: string): Promise<void> },
): Promise<void> {
    let stopped = false;
    if (adapter && c.externalCampaignId) {
        try { await adapter.pauseCampaign(c.externalCampaignId); stopped = true; }
        catch (err) { console.error('[optimise-paid] could not pause on the network', { campaignId: c.id }, err); }
    }
    const now = new Date();
    await db.update(campaigns).set({
        status: 'paused',
        haltReason: reason,
        haltedAt: now,
        ...(stopped ? {} : { controlState: 'lost' as const }),
        updatedAt: now,
    }).where(eq(campaigns.id, c.id));
    await db.update(adVariants).set({ status: 'paused', pauseReason: 'control_lost', updatedAt: now })
        .where(and(eq(adVariants.campaignId, c.id), eq(adVariants.status, 'active')));

    into.halted.push({
        name: c.objective.slice(0, 80),
        reason: stopped || !adapter
            ? reason
            : `${reason} We could not confirm it stopped on LinkedIn — check your Campaign Manager.`,
    });
}

/**
 * One digest per organisation, to the owner.
 *
 * ONE notification per org per run, not one per action — three campaigns adjusting on the same
 * morning is one alert, or this becomes the noise it exists to cut through.
 */
async function notifyOwners(db: any, notices: Map<number, OrgNotice>): Promise<void> {
    for (const n of notices.values()) {
        if (n.paused.length === 0 && n.halted.length === 0) continue;
        const [owner] = await db.select({ userId: userOrganisations.userId })
            .from(userOrganisations)
            .where(eq(userOrganisations.organisationId, n.organisationId))
            .limit(1);
        if (!owner?.userId) continue;

        const [assistant] = n.assistantId
            ? await db.select({ name: aiAssistants.name }).from(aiAssistants)
                .where(eq(aiAssistants.id, n.assistantId)).limit(1)
            : [undefined];
        const assistantName = assistant?.name || 'Your Campaign Assistant';

        // A halt is the more serious of the two and gets its own template, so it is never buried
        // inside a routine "we adjusted things" message.
        for (const h of n.halted) {
            await createNotification(db, 'paid_campaign_halted', {
                userId: owner.userId,
                assistantId: n.assistantId ?? undefined,
                metadata: { assistantId: n.assistantId },
                context: { campaign: { name: h.name, reason: h.reason } },
            });
        }
        if (n.paused.length > 0) {
            await createNotification(db, 'paid_campaign_optimised', {
                userId: owner.userId,
                assistantId: n.assistantId ?? undefined,
                metadata: { assistantId: n.assistantId },
                context: {
                    assistant: { name: assistantName },
                    change: {
                        summary: n.paused.length === 1 ? '1 ad' : `${n.paused.length} ads`,
                        reason: n.paused[0].split('—').slice(1).join('—').trim() || 'They were no longer performing.',
                    },
                },
            });
        }
    }
}
