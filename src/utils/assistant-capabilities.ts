// src/utils/assistant-capabilities.ts
//
// Resolves which features an org can use, based on the assistant TYPES it has hired and the
// admin-managed per-type toggles in `assistant_features`. This generalises the earlier
// "does the org have any active assistant?" gate: a feature is available iff the org has at
// least one ACTIVE assistant whose type has that feature enabled.
//
// "Active" mirrors the Review Queue filter (workspace.html gpPopulateAssistants): not still
// provisioning/failed, and not archived.
//
// Connection split (matches get-assistants.ts): `ai_assistants` is tenant data → read under
// withTenant (RLS); `assistant_features`/`master_assistants` are owner-path config → read on
// the owner connection. We resolve the join in JS to avoid mixing connections in one query.

import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { getDb, withTenant } from '../../db/client';
import { aiAssistants, assistantFeatures, masterAssistants } from '../../db/schema';
import { ASSISTANT_FEATURE_KEYS } from '../config/assistant-features';

type Db = ReturnType<typeof getDb>;

// The set of feature keys this org can use via any of its active assistants.
export async function getOrgEnabledFeatures(db: Db, orgId: number): Promise<Set<string>> {
    // Active assistants in the org (RLS-enforced), with the identifiers we can match a type by.
    const active = await withTenant(orgId, (tx) => tx
        .select({
            masterAssistantId: aiAssistants.masterAssistantId,
            // Legacy rows may have a null master_assistant_id but carry the roleKey in config.
            roleKey: sql<string | null>`(${aiAssistants.configuration} ->> 'type')`,
        })
        .from(aiAssistants)
        .where(and(
            eq(aiAssistants.organisationId, orgId),
            ne(aiAssistants.lifecycleStatus, 'archived'),
            // 'blocked' = gate-blocked provisioning (not yet provisioned) — exclude like pending/failed.
            sql`(${aiAssistants.provisioningStatus} IS NULL OR ${aiAssistants.provisioningStatus} NOT IN ('pending', 'failed', 'blocked'))`,
        )));

    if (active.length === 0) return new Set();

    const activeIds = new Set(active.map(a => a.masterAssistantId).filter((v): v is number => v != null));
    const activeRoles = new Set(active.map(a => a.roleKey).filter((v): v is string => !!v));

    // Enabled feature rows across the catalogue (owner-path; small table).
    const rows = await db
        .select({
            masterAssistantId: assistantFeatures.masterAssistantId,
            roleKey: masterAssistants.roleKey,
            featureKey: assistantFeatures.featureKey,
        })
        .from(assistantFeatures)
        .innerJoin(masterAssistants, eq(masterAssistants.id, assistantFeatures.masterAssistantId))
        .where(and(
            eq(assistantFeatures.enabled, true),
            inArray(assistantFeatures.featureKey, ASSISTANT_FEATURE_KEYS),
        ));

    const enabled = new Set<string>();
    for (const r of rows) {
        if (activeIds.has(r.masterAssistantId) || (r.roleKey && activeRoles.has(r.roleKey))) {
            enabled.add(r.featureKey);
        }
    }
    return enabled;
}

export async function orgHasAssistantFeature(db: Db, orgId: number, featureKey: string): Promise<boolean> {
    return (await getOrgEnabledFeatures(db, orgId)).has(featureKey);
}

// Convenience for the My Content media gates — both flags from a single resolution pass.
export async function getOrgMediaCapabilities(db: Db, orgId: number): Promise<{ canImage: boolean; assistantCanVideo: boolean }> {
    const enabled = await getOrgEnabledFeatures(db, orgId);
    return {
        canImage: enabled.has('ai_image_generation'),
        assistantCanVideo: enabled.has('ai_video_generation'),
    };
}

// Standard 403 for a capability the org's assistants don't have. `code` lets the client
// distinguish this from other 403s (e.g. the video tier-lock) and surface the right message.
export function featureUnavailableResponse(message: string) {
    return {
        statusCode: 403,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: message, code: 'feature_unavailable' }),
    };
}
