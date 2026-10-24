// src/utils/recompile-org-blueprints.ts
// Refresh every compiled blueprint in ONE organisation after its Business Information documents or
// links change.
//
// ── Why ──────────────────────────────────────────────────────────────────────────────────────────
// Blueprint §11 (Business Knowledge) is a SNAPSHOT of workspace_assets taken when the blueprint is
// compiled, and drafting reads the snapshot: blog-generate.ts takes the newest blueprint, social
// jobs carry a blueprint id. Nothing recompiled on an asset change — only a rule, goal or profile
// edit did — so a brand guide uploaded after an assistant's first draft never reached its drafts,
// while the Brand Knowledge card said it was "applied as a strict rule" (owner, 2026-10-23).
//
// Workspace assets are org-wide, so every assistant in the org that already has a blueprint is
// recompiled. Assistants with none compile on their first draft anyway, from current data.
// assembleBlueprint is database-only (no model call), so this is cheap enough to await inline.
//
// ⚠️ Never throws: the asset change has already been saved, and one assistant failing must not stop
// the rest. Call it AFTER the workspace_assets write.

import { and, eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiBlueprints } from '../../db/schema';
import { assembleBlueprint } from './blueprint';

type Db = ReturnType<typeof getDb>;

export async function recompileOrgBlueprints(db: Db, organisationId: number, reason: string): Promise<number> {
    let recompiled = 0;
    try {
        const rows = await db.selectDistinct({ assistantId: aiBlueprints.assistantId })
            .from(aiBlueprints)
            .where(and(eq(aiBlueprints.organisationId, organisationId)));
        for (const { assistantId } of rows) {
            try {
                await assembleBlueprint(assistantId, 'system', reason);
                recompiled++;
            } catch (err) {
                console.error(`[recompile-org-blueprints] assistant ${assistantId} failed (non-fatal)`, err instanceof Error ? err.message : err);
            }
        }
    } catch (err) {
        console.error(`[recompile-org-blueprints] org ${organisationId} lookup failed (non-fatal)`, err);
    }
    return recompiled;
}
