// src/utils/blueprint-version.ts
// Resolve the blueprint version that is LIVE for an assistant right now, so revenue_events rows
// can be attributed to the strategy that produced them.
//
// Design: docs/lead-generator-revenue-engine-plan.md §7.2, docs/strategy-agent-plan.md §0.2.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// `revenue_events.blueprint_version` is what the Strategy Agent joins on. Without it you can
// measure that win rate moved but not WHICH strategy version moved it, and the loop degenerates
// into correlating noise (§7.2). Every recordEvent() call site should pass one.
//
// ⚠️ THIS CANNOT BE BACKFILLED. `ai_blueprints` keeps one row per compile, so the version live at
// some past moment is recoverable only if nothing was recompiled since — and the profile save
// recompiles on a 1.2s debounce. An event written with a NULL blueprint_version is permanently
// unattributable. That is why the value is captured at write time and never reconstructed later.
//
// ── Never throws ─────────────────────────────────────────────────────────────
// Same contract as revenue-ledger.ts: attribution is an OBSERVER of the pipeline. A failed lookup
// resolves to null (an unattributable but otherwise complete event) rather than breaking the send,
// the approval or the discovery run that triggered it. Callers need no try/catch.
//
// A null return is a legitimate, expected outcome — an assistant whose blueprint has never been
// compiled has no version, and events for it are unattributable by definition, exactly like the
// Phase 0 backfill rows. The analyser must exclude NULLs rather than treat them as a cohort
// (docs/strategy-agent-plan.md §4.2).

import { desc, eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiBlueprints } from '../../db/schema';

type Db = ReturnType<typeof getDb>;

/**
 * The blueprint version currently live for one assistant, or null when it has never been compiled
 * (or the lookup failed).
 *
 * Prefer {@link makeBlueprintVersionCache} inside a loop — this issues a query per call.
 */
export async function getBlueprintVersion(db: Db, assistantId: number | null | undefined): Promise<string | null> {
    if (!Number.isInteger(assistantId)) return null;
    try {
        // Latest compile wins. `compiled_at` rather than `id` because assembleBlueprint REUSES an
        // existing row when a recompile produces identical section content, so the highest id is
        // not necessarily the newest state — see src/utils/blueprint.ts.
        const [row] = await db
            .select({ blueprintVersion: aiBlueprints.blueprintVersion })
            .from(aiBlueprints)
            .where(eq(aiBlueprints.assistantId, assistantId as number))
            .orderBy(desc(aiBlueprints.compiledAt))
            .limit(1);
        return row?.blueprintVersion ?? null;
    } catch (err) {
        console.error('[blueprint-version] lookup failed; event will be unattributable', { assistantId }, err);
        return null;
    }
}

/**
 * A memoised lookup for hot paths that emit many events across a handful of assistants — the
 * discovery worker's per-lead loop, the sequence send worker, batch approve.
 *
 * ⚠️ Create one per invocation and let it fall out of scope. A module-level cache would survive in
 * a warm Lambda container and keep stamping a stale version after a recompile — which is the exact
 * attribution corruption this module exists to prevent. The cache is only safe because its lifetime
 * is one run.
 *
 * Caches null results too: an assistant with no blueprint should cost one query per run, not one
 * per lead.
 */
export function makeBlueprintVersionCache(db: Db): (assistantId: number | null | undefined) => Promise<string | null> {
    const cache = new Map<number, string | null>();
    return async (assistantId) => {
        if (!Number.isInteger(assistantId)) return null;
        const key = assistantId as number;
        const hit = cache.get(key);
        if (hit !== undefined) return hit;
        const version = await getBlueprintVersion(db, key);
        cache.set(key, version);
        return version;
    };
}
