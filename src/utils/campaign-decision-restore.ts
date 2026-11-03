// src/utils/campaign-decision-restore.ts
// Put an archived campaign decision back in the Decisions queue.
//
// ── The hole this fills ─────────────────────────────────────────────────────────────────────────
// A decision leaves the queue three ways: the user turns it down, a newer plan replaces it, or it
// expires. Expiry is the common one, and for a halt it is two days (DECISION_TTL_DAYS), so a
// "this search is finding the wrong companies" card raised on a Friday was gone by Monday. Its
// mirror went to 'rejected', which the Decisions tab draws under Archived, with no button at all —
// the owner could read the evidence and could not act on it (2026-11-03).
//
// ── What a restore does ─────────────────────────────────────────────────────────────────────────
// The same row goes back to 'pending' (never a copy: one decision, one history) with a FRESH
// expiry of its kind's TTL, and the rejection fields cleared — the CHECK on reject_reason only
// binds a 'rejected' row. Its mirror goes back to 'pending_approval', so it reappears in Review.
// Approving it afterwards is the ordinary `decide`, unchanged.
//
// ── Stale evidence ──────────────────────────────────────────────────────────────────────────────
// A halt's figures are a COUNT, and the count can be taken again, so a restored halt is
// RE-MEASURED: the search's leads since the original window opened, with the original figures kept
// as one more line. If the search is now under the threshold it is still restored — the user asked
// for it — but the line says so, rather than showing old numbers as if they were today's.
// Its new search description is worked out again too (halt-tightening.ts), against the search's
// wording TODAY: a halt raised before 2026-11-03 carried none, and one raised since may predate an
// edit the user made, which the executor would then refuse to overwrite.
// Every other kind's evidence cannot be re-measured here (a post's lead over the average, a plan the
// user agreed in chat), so it is restored as it was with a line stating the date it is from.
//
// ── What it refuses ─────────────────────────────────────────────────────────────────────────────
// * Approved and superseded decisions. Approved already placed its orders; superseded was replaced
//   by a newer plan, and restoring it would put two plans on one campaign (campaign-plan.ts rule 1).
// * A second pending decision of the same kind on the campaign — the proposer's own dedupe rule.
// * A finished or archived campaign: nothing it proposes can run there.
// * A halt whose saved search is gone or archived: narrow_targeting would have nothing to narrow.
// A rejected decision CAN be restored. The reason given when it was turned down stays in the
// campaign's constraints: it was the user's answer at the time, and unpicking it from a merged set
// would guess at which words came from which rejection.

import { and, desc, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import { assistantRecords, campaignDecisions, campaigns, discoveredLeads, discoveryCampaigns } from '../../db/schema';
import { mirrorDecision } from './campaign-mirror';
import { LEAD_QUALITY_FLOOR, MIN_LEADS_FOR_QUALITY, narrowTargetingBrief, type EvidenceItem } from './campaign-proposer';
import { proposeTightening, type Tightening } from './halt-tightening';
import { DECISION_TTL_DAYS, type CampaignDecisionKind } from '../config/campaign-vocab';

type Db = Parameters<typeof mirrorDecision>[0];

/** The statuses an archived card can be in and still come back. */
export const RESTORABLE_DECISION_STATUSES = ['expired', 'rejected'] as const;

/** How far back a restored halt counts from: the proposer's own window (autonomous-campaign-agent since24h). */
const HALT_WINDOW_MS = 24 * 60 * 60 * 1000;

export type RestoreResult =
    | {
        ok: true; decisionId: number; campaignId: number; kind: string; expiresAt: Date; remeasured: boolean; belowThreshold: boolean; keptRejectReason: boolean;
        /** A halt only: what approving it will now do to the search — rewrite its description, or pause it. */
        searchChange?: 'rewrite' | 'pause';
    }
    | { ok: false; status: number; error: string };

const DAY_MS = 24 * 60 * 60 * 1000;
const dateLabel = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London' });

/** Why this decision cannot come back, or null if it can. Pure, for the test. */
export function restoreProblem(status: string, campaignStatus: string): string | null {
    if (status === 'pending') return 'This decision is already waiting in Decisions.';
    if (status === 'approved') return 'This decision was approved and its briefs were issued, so there is nothing to restore. See the Briefs tab.';
    if (status === 'superseded') return 'A newer plan replaced this one. Restore is only for decisions that expired or were turned down.';
    if (!(RESTORABLE_DECISION_STATUSES as readonly string[]).includes(status)) return 'This decision cannot be restored.';
    if (campaignStatus === 'finished' || campaignStatus === 'archived') {
        return `Its campaign is ${campaignStatus}, so nothing this decision proposes could run. Start a new campaign instead.`;
    }
    return null;
}

/**
 * The evidence a restored halt shows: today's count for the same search, then what it said when it
 * was raised. Pure, for the test.
 */
export function remeasuredHaltEvidence(
    now: { total: number; cold: number; since: Date },
    original: EvidenceItem[],
    raisedAt: Date,
): { evidence: EvidenceItem[]; belowThreshold: boolean } {
    const share = now.total ? now.cold / now.total : 0;
    const pct = Math.round(share * 100);
    // Too few leads is not a recovery — it is no signal (the proposer's own MIN_LEADS_FOR_QUALITY).
    const tooFew = now.total < MIN_LEADS_FOR_QUALITY;
    const belowThreshold = !tooFew && share <= LEAD_QUALITY_FLOOR;
    const was = original.find((e) => e && e.label === 'Rated cold');
    const wasTotal = original.find((e) => e && e.label === 'Leads found in the window');
    return {
        belowThreshold,
        evidence: [
            // No `detail` on any line: _rqDecisionDetail numbers a line that has one as a brief.
            { label: `Leads found since ${dateLabel(now.since)} (counted again when you restored it)`, value: String(now.total) },
            {
                label: 'Rated cold',
                value: `${now.cold} (${pct}%)${tooFew ? ' — too few leads since to judge again' : belowThreshold ? ' — now at or under your threshold, so you may not need this any more' : ''}`,
            },
            { label: 'Your threshold', value: `${Math.round(LEAD_QUALITY_FLOOR * 100)}%` },
            ...(was ? [{
                label: `When it was raised (${dateLabel(raisedAt)})`,
                value: `${was.value} rated cold${wasTotal ? ` of ${wasTotal.value}` : ''}`,
            }] : []),
        ],
    };
}

/** Evidence that cannot be re-counted keeps its lines and says how old they are. Pure, for the test. */
export function datedEvidence(original: EvidenceItem[], raisedAt: Date): EvidenceItem[] {
    const kept = original.filter((e) => e && e.label !== 'Restored');
    return [...kept, { label: 'Restored', value: `These figures are from ${dateLabel(raisedAt)} and were not measured again` }];
}

/**
 * Restore one decision. `organisationId` scopes every read; the caller has already checked the
 * user may act for this workspace (requireTenant in campaigns.ts).
 */
export async function restoreDecision(db: Db, organisationId: number, decisionId: number): Promise<RestoreResult> {
    if (!Number.isInteger(decisionId) || decisionId <= 0) return { ok: false, status: 400, error: 'Which decision? None was named.' };

    const [d] = await db.select().from(campaignDecisions)
        .where(and(eq(campaignDecisions.id, decisionId), eq(campaignDecisions.organisationId, organisationId)))
        .limit(1);
    if (!d) return { ok: false, status: 404, error: 'Decision not found.' };

    const [campaign] = await db.select({
        id: campaigns.id, status: campaigns.status, objective: campaigns.objective, aiAssistantId: campaigns.aiAssistantId,
    }).from(campaigns)
        .where(and(eq(campaigns.id, d.campaignId), eq(campaigns.organisationId, organisationId)))
        .limit(1);
    if (!campaign) return { ok: false, status: 404, error: 'Campaign not found.' };

    const problem = restoreProblem(d.status, campaign.status);
    if (problem) return { ok: false, status: d.status === 'pending' ? 409 : 400, error: problem };

    const [twin] = await db.select({ id: campaignDecisions.id }).from(campaignDecisions)
        .where(and(
            eq(campaignDecisions.campaignId, d.campaignId),
            eq(campaignDecisions.kind, d.kind),
            eq(campaignDecisions.status, 'pending'),
            ne(campaignDecisions.id, d.id),
        ))
        .limit(1);
    if (twin) {
        return {
            ok: false, status: 409,
            error: d.kind === 'strategy'
                ? 'This campaign already has a plan waiting in Decisions. Approve or turn that one down first.'
                : 'A decision like this one is already waiting in Decisions for the same campaign — act on that one instead.',
        };
    }

    const original = (Array.isArray(d.evidence) ? d.evidence : []) as EvidenceItem[];
    let evidence = datedEvidence(original, d.createdAt);
    let remeasured = false;
    let belowThreshold = false;
    let proposed = d.proposed;
    let searchChange: 'rewrite' | 'pause' | undefined;

    if (d.kind === 'halt') {
        const orders = ((d.proposed ?? {}) as { orders?: Array<{ action?: string; brief?: Record<string, unknown> }> }).orders ?? [];
        const searchId = Number(orders.find((o) => o.action === 'narrow_targeting')?.brief?.discoveryCampaignId);
        if (!Number.isInteger(searchId)) {
            return { ok: false, status: 400, error: 'This decision does not name the saved search it was about, so it cannot be acted on.' };
        }
        const [search] = await db.select({ id: discoveryCampaigns.id, status: discoveryCampaigns.status })
            .from(discoveryCampaigns)
            .where(and(eq(discoveryCampaigns.id, searchId), eq(discoveryCampaigns.organisationId, organisationId)))
            .limit(1);
        if (!search || search.status === 'archived') {
            return { ok: false, status: 400, error: 'The lead search this decision was about has since been archived or deleted, so there is nothing left for it to change.' };
        }
        const since = new Date(d.createdAt.getTime() - HALT_WINDOW_MS);
        const [count] = await db.select({
            total: sql<number>`COUNT(*)::int`,
            cold: sql<number>`COUNT(*) FILTER (WHERE ${discoveredLeads.rating} = 'cold')::int`,
        }).from(discoveredLeads)
            .where(and(eq(discoveredLeads.campaignId, searchId), gte(discoveredLeads.createdAt, since)));
        const fresh = remeasuredHaltEvidence(
            { total: Number(count?.total ?? 0), cold: Number(count?.cold ?? 0), since },
            original, d.createdAt,
        );
        evidence = fresh.evidence;
        belowThreshold = fresh.belowThreshold;
        remeasured = true;

        const tightening: Tightening | null = await proposeTightening(db, organisationId, searchId, since);
        const brief = narrowTargetingBrief(searchId, tightening);
        proposed = {
            ...((d.proposed ?? {}) as Record<string, unknown>),
            orders: orders.map((o) => (o.action === 'narrow_targeting' ? { ...o, brief } : o)),
        };
        searchChange = brief.idea ? 'rewrite' : 'pause';
    }

    const expiresAt = new Date(Date.now() + DECISION_TTL_DAYS[d.kind as CampaignDecisionKind] * DAY_MS);
    const keptRejectReason = d.status === 'rejected';

    // Guarded on the status read above, so two clicks (the tab and a chat card) cannot both write.
    const updated = await db.update(campaignDecisions).set({
        status: 'pending',
        expiresAt,
        evidence,
        proposed,
        rejectReason: null,
        rejectNote: null,
        decidedAt: null,
        decidedBy: null,
        updatedAt: new Date(),
    }).where(and(eq(campaignDecisions.id, d.id), eq(campaignDecisions.status, d.status)))
        .returning({ id: campaignDecisions.id });
    if (!updated.length) return { ok: false, status: 409, error: 'This decision changed while you were looking at it. Reload to see where it is now.' };

    // The mirror is what puts it back in the Decisions column. Refreshed in place when it exists, so
    // the card keeps its id; written fresh when it was lost (mirrors are best-effort).
    const mirrorData = {
        kind: 'campaign_decision',
        decisionId: d.id,
        decisionKind: d.kind,
        campaign: campaign.objective,
        evidence,
        costOfInaction: d.costOfInaction ?? null,
        workItems: d.costWorkItems,
        expiresAt: expiresAt.toISOString(),
        restoredAt: new Date().toISOString(),
    };
    let mirrored = false;
    if (d.assistantRecordId) {
        const rows = await db.update(assistantRecords)
            .set({ approvalStatus: 'pending_approval', data: mirrorData, updatedAt: new Date() })
            .where(and(eq(assistantRecords.id, d.assistantRecordId), eq(assistantRecords.organisationId, organisationId)))
            .returning({ id: assistantRecords.id });
        mirrored = rows.length > 0;
    }
    if (!mirrored) {
        await mirrorDecision(db, {
            organisationId, aiAssistantId: campaign.aiAssistantId, decisionId: d.id,
            kind: d.kind as CampaignDecisionKind, title: d.title, campaignObjective: campaign.objective,
            evidence, costOfInaction: d.costOfInaction, workItems: d.costWorkItems, expiresAt,
        });
    }

    return { ok: true, decisionId: d.id, campaignId: d.campaignId, kind: d.kind, expiresAt, remeasured, belowThreshold, keptRejectReason, searchChange };
}

/** The sentence both the tab and the chat card show after a restore. Pure, for the test. */
export function restoredMessage(r: Pick<Extract<RestoreResult, { ok: true }>, 'kind' | 'expiresAt' | 'remeasured' | 'belowThreshold' | 'keptRejectReason' | 'searchChange'>): string {
    const days = Math.max(1, Math.round((r.expiresAt.getTime() - Date.now()) / DAY_MS));
    const parts = [`Back in Decisions. You have ${days} day${days === 1 ? '' : 's'} to approve or turn it down.`];
    if (r.remeasured) {
        parts.push(r.belowThreshold
            ? 'Its figures were counted again and the search is now under your threshold, so check you still want it.'
            : 'Its figures were counted again, so they are today\'s.');
    } else if (r.kind !== 'halt') {
        parts.push('Its figures are from when it was raised.');
    }
    if (r.searchChange === 'rewrite') {
        parts.push('A narrower description for the search was worked out from its cold leads; read it under "If you approve" before approving.');
    } else if (r.searchChange === 'pause') {
        parts.push('No narrower description could be worked out from its cold leads, so approving it will pause the search rather than change it.');
    }
    if (r.keptRejectReason) parts.push('The reason you gave when you turned it down is still noted on the campaign.');
    return parts.join(' ');
}

/** How far back the chat is shown archived decisions. Older than this, a restore would mostly be news. */
const ARCHIVED_LOOKBACK_DAYS = 60;

/**
 * The archived decisions on one campaign, for the chat's campaign snapshot. The chat can only offer
 * to restore a decision it has been shown, by its decisionId — the same rule as tasks and searches.
 */
export async function archivedDecisionsLine(db: Db, campaignId: number): Promise<string> {
    const rows = await db.select({
        id: campaignDecisions.id, title: campaignDecisions.title, kind: campaignDecisions.kind,
        status: campaignDecisions.status, updatedAt: campaignDecisions.updatedAt,
    }).from(campaignDecisions)
        .where(and(
            eq(campaignDecisions.campaignId, campaignId),
            inArray(campaignDecisions.status, [...RESTORABLE_DECISION_STATUSES]),
            gte(campaignDecisions.updatedAt, new Date(Date.now() - ARCHIVED_LOOKBACK_DAYS * DAY_MS)),
        ))
        .orderBy(desc(campaignDecisions.updatedAt))
        .limit(5);
    if (!rows.length) return '';
    return `. Archived decisions (under Decisions ▸ Archived; each can be restored): ${rows.map((r) =>
        `decisionId ${r.id} "${r.title.slice(0, 140)}" (${r.kind}, ${r.status === 'expired' ? 'expired' : 'turned down'} ${dateLabel(r.updatedAt)})`).join('; ')}`;
}
