// src/utils/icp-snapshot.ts
// Resolve the ICP that was live for a lead when it was found, so revenue_events rows can be
// attributed to the targeting that produced them.
//
// Design: docs/lead-generator-revenue-engine-plan.md §7.2, docs/strategy-agent-plan.md §0.2.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// `revenue_events.icp_snapshot` is the other half of the attribution join key (the first being
// blueprint_version — see blueprint-version.ts, which this module deliberately mirrors). The
// Strategy Agent's win/loss analyser groups terminal outcomes BY icp_snapshot dimensions: that is
// how "we win with 50+ headcount manufacturers and lose with 10-person agencies" becomes a
// proposal. An event with a NULL snapshot is invisible to every one of those segments.
//
// ⚠️ THIS CANNOT BE BACKFILLED, for a subtler reason than blueprint_version. A campaign's
// `icp_snapshot` is taken at activation and is stable, so today's value is recoverable — but the
// LEAD→campaign link is not the whole story: onboarding-derived fallbacks (manually added leads)
// depend on `onboarding_context`, which the profile save overwrites in place with no history. So
// for exactly the leads that have no campaign, the value is gone the moment onboarding changes.
// Capture at write time; never reconstruct later.
//
// ── Which ICP is the right one ───────────────────────────────────────────────
// The campaign's activation-time snapshot, NOT the org's current onboarding. This is the rule the
// discovery worker already follows and states: it says which ICP was live when this lead was found,
// not which one is live when the aggregate runs. Attributing a deal won today to today's ICP would
// credit the current targeting for a lead the previous targeting found — precisely the
// correlating-noise failure §7.2 exists to prevent.
//
// So: lead → its campaign's snapshot. Only when there is no lead (a manually added record, an
// assistant-level event) does the onboarding-derived shape apply, and that is a legitimately
// different, weaker attribution rather than a lookup failure.
//
// ── Never throws ─────────────────────────────────────────────────────────────
// Same contract as revenue-ledger.ts and blueprint-version.ts: attribution is an OBSERVER of the
// pipeline. A failed lookup resolves to null (an unattributable but otherwise complete event)
// rather than breaking the send, the approval or the discovery run that triggered it. Callers need
// no try/catch.

import { eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, discoveredLeads, discoveryCampaigns } from '../../db/schema';

type Db = ReturnType<typeof getDb>;

/**
 * What a caller knows about the thing the event is about. Supply whatever is in scope; resolution
 * runs strongest-first (lead → record → assistant) and stops at the first hit.
 */
export interface IcpRef {
    discoveredLeadId?: number | null;
    /** A mirrored lead record. Resolved by walking record → discovered lead → campaign. */
    assistantRecordId?: number | null;
    aiAssistantId?: number | null;
}

/**
 * Build the ICP snapshot from an assistant's onboarding answers.
 *
 * ⚠️ This is the ONE definition of the snapshot's shape. It was previously duplicated in
 * src/utils/discovery.ts (3 fields, written to every campaign) and inline in
 * netlify/functions/lead-generation.ts (2 fields — no `salesTone`), which meant two events about
 * the same org could carry snapshots that do not GROUP BY together. A segment that splits on the
 * mere presence of a key is not a segment. Import this; do not re-inline it.
 */
export function icpFromOnboarding(onboarding: unknown): Record<string, unknown> {
    const o = (onboarding && typeof onboarding === 'object' && !Array.isArray(onboarding)
        ? onboarding
        : {}) as Record<string, unknown>;
    return {
        targetIndustries: o.targetIndustries ?? null,
        minHeadcount: o.minHeadcount ?? null,
        salesTone: o.salesTone ?? 'professional',
    };
}

/** True for a snapshot that carries no actual targeting — treated as absent, so the fallback runs. */
function isEmptySnapshot(v: unknown): boolean {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return true;
    return Object.keys(v as Record<string, unknown>).length === 0;
}

/**
 * The ICP snapshot to attribute one event to, or null when nothing is resolvable.
 *
 * Prefers the lead's campaign snapshot; falls back to the assistant's current onboarding.
 * Prefer {@link makeIcpSnapshotCache} inside a loop — this issues up to two queries per call.
 */
export async function getIcpSnapshot(db: Db, ref: IcpRef): Promise<Record<string, unknown> | null> {
    // ── Campaign snapshot, via the lead ──────────────────────────────────────
    // discovered_leads.campaign_id is NOT NULL, so a lead always has a campaign; the inner join
    // cannot silently drop the row the way a left join on a nullable key would.
    if (Number.isInteger(ref.discoveredLeadId)) {
        try {
            const [row] = await db
                .select({ icpSnapshot: discoveryCampaigns.icpSnapshot })
                .from(discoveredLeads)
                .innerJoin(discoveryCampaigns, eq(discoveryCampaigns.id, discoveredLeads.campaignId))
                .where(eq(discoveredLeads.id, ref.discoveredLeadId as number))
                .limit(1);
            if (row && !isEmptySnapshot(row.icpSnapshot)) {
                return row.icpSnapshot as Record<string, unknown>;
            }
            // Fall through: a campaign predating the snapshot column has none, and the assistant's
            // onboarding is a better attribution than nothing.
        } catch (err) {
            console.error('[icp-snapshot] campaign lookup failed; trying onboarding', { leadId: ref.discoveredLeadId }, err);
        }
    }

    // ── Campaign snapshot, via the mirrored record ───────────────────────────
    // For call sites that only hold an assistant_records id (the Review Queue actions, outcome
    // capture, the opening send). A manually added lead has no discovered_leads row, so a miss here
    // is the expected shape rather than a failure — fall through to onboarding.
    if (Number.isInteger(ref.assistantRecordId)) {
        try {
            const [row] = await db
                .select({ icpSnapshot: discoveryCampaigns.icpSnapshot })
                .from(discoveredLeads)
                .innerJoin(discoveryCampaigns, eq(discoveryCampaigns.id, discoveredLeads.campaignId))
                .where(eq(discoveredLeads.assistantRecordId, ref.assistantRecordId as number))
                .limit(1);
            if (row && !isEmptySnapshot(row.icpSnapshot)) {
                return row.icpSnapshot as Record<string, unknown>;
            }
        } catch (err) {
            console.error('[icp-snapshot] record lookup failed; trying onboarding', { recordId: ref.assistantRecordId }, err);
        }
    }

    // ── Onboarding fallback ──────────────────────────────────────────────────
    if (Number.isInteger(ref.aiAssistantId)) {
        try {
            const [row] = await db
                .select({ onboardingContext: aiAssistants.onboardingContext })
                .from(aiAssistants)
                .where(eq(aiAssistants.id, ref.aiAssistantId as number))
                .limit(1);
            if (!row) return null;
            return icpFromOnboarding(row.onboardingContext);
        } catch (err) {
            console.error('[icp-snapshot] onboarding lookup failed; event will be unattributable', { assistantId: ref.aiAssistantId }, err);
            return null;
        }
    }

    return null;
}

/**
 * A memoised lookup for hot paths that emit many events — the sequence send worker, batch approve,
 * the discovery worker's per-lead loop.
 *
 * ⚠️ Create one per invocation and let it fall out of scope. A module-level cache would survive in
 * a warm Lambda container and keep stamping a stale snapshot after the user retargets — the exact
 * attribution corruption this module exists to prevent. The cache is only safe because its lifetime
 * is one run. (Same warning, same reason, as makeBlueprintVersionCache.)
 *
 * Caches nulls too: an unresolvable ref should cost one query per run, not one per lead.
 */
export function makeIcpSnapshotCache(db: Db): (ref: IcpRef) => Promise<Record<string, unknown> | null> {
    const cache = new Map<string, Record<string, unknown> | null>();
    return async (ref) => {
        // Two key spaces in one map — a lead id and an assistant id can collide numerically, and a
        // lead's campaign snapshot is not interchangeable with its assistant's onboarding.
        const key = Number.isInteger(ref.discoveredLeadId)
            ? `l:${ref.discoveredLeadId}`
            : Number.isInteger(ref.assistantRecordId)
                ? `r:${ref.assistantRecordId}`
                : Number.isInteger(ref.aiAssistantId)
                    ? `a:${ref.aiAssistantId}`
                    : '';
        if (!key) return null;
        const hit = cache.get(key);
        if (hit !== undefined) return hit;
        const snapshot = await getIcpSnapshot(db, ref);
        cache.set(key, snapshot);
        return snapshot;
    };
}
