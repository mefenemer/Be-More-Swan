// netlify/functions/content-rules.ts
// US-SMM-2.3.1: Content Rules Library — CRUD for per-assistant overarching content rules.
// Rules are injected into the generation prompt for all future drafts by the assistant.
//
// GET  ?assistantId=N[&platform=X]  — list rules (active + inactive): this assistant's own AND the
//      workspace-wide ones (assistant_id NULL), each with `scope`; plus canManageWorkspaceRules
// POST { assistantId, ruleText, platform?, note?, scope? }  — create rule manually
//      (scope 'workspace' = every assistant: owners and admins only — src/utils/workspace-rules.ts)
// PATCH { id, ruleText?, platform?, note?, isActive?, scope?, assistantId? }  — edit, toggle, or move
//      between this assistant and every assistant (scope 'assistant' needs assistantId)
// DELETE ?id=N  — hard delete
//
// A workspace-wide rule (FR#10) is read by every assistant, so changing one recompiles every
// assistant's blueprint (recompileOrgBlueprints), and only owners and admins may change one.

import { Handler } from '@netlify/functions';
import { and, eq, isNull, or } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { contentRules, aiAssistants, scheduledPosts } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { assembleBlueprint } from '../../src/utils/blueprint';
import { recompileOrgBlueprints } from '../../src/utils/recompile-org-blueprints';
import { WORKSPACE_RULE_FORBIDDEN, canManageWorkspaceRules, parseRuleScope, ruleScopeOf } from '../../src/utils/workspace-rules';
import { withLambda } from '@netlify/aws-lambda-compat';

/**
 * Recompile the blueprint so a rule change actually reaches the model.
 *
 * Rules are consumed from the COMPILED blueprint (section 4), not from content_rules live:
 * process-content-jobs dumps the blueprint into the generation prompt, and post-quality-review
 * reads section 4 out of the latest persisted row. Without this, a rule added here sat dormant
 * until some unrelated recompile happened — the exact gap reject-post.ts already closes for
 * rejection-feedback rules.
 *
 * Applies to every mutation, not just create: deactivating a rule (section 4 filters on isActive),
 * editing its text, and deleting it all change what the assistant is steered by.
 *
 * Best-effort by design — data assembly, no LLM call. A recompile failure must never fail the
 * user's edit, which is already committed by the time this runs.
 */
async function recompileAfterRuleChange(assistantId: number | null, userId: number, what: string) {
    if (!assistantId) return;
    try {
        await assembleBlueprint(assistantId, `user-${userId}`, 'context_update');
    } catch (e) {
        console.warn(`[content-rules] blueprint recompile after ${what} failed (change still saved):`, e instanceof Error ? e.message : e);
    }
}

/**
 * The same, for a change that touches a workspace-wide rule (before OR after the change): every
 * assistant reads it, so every compiled blueprint in the workspace is refreshed. Never throws.
 */
async function recompileForRule(db: ReturnType<typeof getDb>, orgId: number, before: number | null | undefined, after: number | null | undefined, userId: number, what: string) {
    if (before === null || after === null) {
        await recompileOrgBlueprints(db, orgId, 'content_rules_workspace');
        return;
    }
    await recompileAfterRuleChange(after ?? before ?? null, userId, what);
    if (before != null && after != null && before !== after) await recompileAfterRuleChange(before, userId, what);
}

const forbidden = () => ({ statusCode: 403, body: JSON.stringify({ error: WORKSPACE_RULE_FORBIDDEN }) });

export default withLambda(async (event) => {
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;

    const orgId = ctx.organisationId;
    const userId = ctx.userId;
    const canManageWorkspace = canManageWorkspaceRules(ctx.role);

    const method = event.httpMethod;
    const params = event.queryStringParameters || {};

    // ── GET — list rules for an assistant ────────────────────────────────────
    if (method === 'GET') {
        const assistantId = params.assistantId ? Number(params.assistantId) : NaN;
        if (isNaN(assistantId)) {
            return { statusCode: 400, body: JSON.stringify({ error: 'assistantId is required.' }) };
        }

        // Verify the caller owns this assistant (via org)
        const [assistant] = await db.select({ orgId: aiAssistants.organisationId })
            .from(aiAssistants)
            .where(eq(aiAssistants.id, assistantId))
            .limit(1);
        if (!assistant || assistant.orgId !== orgId) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Assistant not found.' }) };
        }

        // This assistant's own rules AND the workspace-wide ones every assistant follows, so the page
        // never hides a rule its assistant obeys (FR#10).
        const rows = await db.select().from(contentRules)
            .where(and(
                eq(contentRules.workspaceId, orgId),
                or(eq(contentRules.assistantId, assistantId), isNull(contentRules.assistantId)),
                params.platform
                    ? or(isNull(contentRules.platform), eq(contentRules.platform, params.platform))
                    : undefined,
            ))
            .orderBy(contentRules.createdAt);

        // Enrich rules that trace back to a post (rejection feedback + tuning) with its caption snippet.
        const enriched = await Promise.all(rows.map(async (rule) => {
            if ((rule.origin !== 'rejection_feedback' && rule.origin !== 'tuning') || !rule.originPostId) return { ...rule, scope: ruleScopeOf(rule) };
            const [originPost] = await db
                .select({ id: scheduledPosts.id, caption: scheduledPosts.caption, platform: scheduledPosts.platform })
                .from(scheduledPosts)
                .where(eq(scheduledPosts.id, rule.originPostId))
                .limit(1);
            return { ...rule, scope: ruleScopeOf(rule), originPost: originPost ?? null };
        }));

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rules: enriched, canManageWorkspaceRules: canManageWorkspace }),
        };
    }

    // ── POST — create rule manually ───────────────────────────────────────────
    if (method === 'POST') {
        let body: any = {};
        try { body = JSON.parse(event.body || '{}'); } catch {
            return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) };
        }

        const { assistantId, ruleText, platform, note, category } = body;
        const scope = parseRuleScope(body.scope);
        if (scope === 'workspace' && !canManageWorkspace) return forbidden();
        if (!assistantId || !ruleText?.trim()) {
            return { statusCode: 400, body: JSON.stringify({ error: 'assistantId and ruleText are required.' }) };
        }
        if (ruleText.trim().length > 300) {
            return { statusCode: 400, body: JSON.stringify({ error: 'ruleText must be 300 characters or fewer.' }) };
        }

        // Verify ownership
        const [assistant] = await db.select({ orgId: aiAssistants.organisationId })
            .from(aiAssistants)
            .where(eq(aiAssistants.id, Number(assistantId)))
            .limit(1);
        if (!assistant || assistant.orgId !== orgId) return { statusCode: 404, body: JSON.stringify({ error: 'Assistant not found.' }) };

        const [rule] = await db.insert(contentRules).values({
            // NULL = every assistant in the workspace. assistantId is still required above: it is the
            // assistant the user was on, and proves the request comes from inside this workspace.
            assistantId:     scope === 'workspace' ? null : Number(assistantId),
            workspaceId:     orgId,
            ruleText:        ruleText.trim(),
            category:        category?.trim() || null,
            platform:        scope === 'workspace' ? null : (platform || null),
            note:            note?.trim() || null,
            createdByUserId: userId,
            isActive:        true,
            origin:          'manual',
        }).returning();

        if (scope === 'workspace') await recompileForRule(db, orgId, null, null, userId, 'create');
        else await recompileAfterRuleChange(Number(assistantId), userId, 'create');

        return {
            statusCode: 201,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rule: { ...rule, scope: ruleScopeOf(rule) } }),
        };
    }

    // ── PATCH — edit rule text, scope, note, or toggle isActive ──────────────
    if (method === 'PATCH') {
        let body: any = {};
        try { body = JSON.parse(event.body || '{}'); } catch {
            return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) };
        }

        const { id, ruleText, platform, note, isActive, category } = body;
        if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'id is required.' }) };

        const [existing] = await db.select().from(contentRules)
            .where(eq(contentRules.id, Number(id)))
            .limit(1);
        if (!existing) return { statusCode: 404, body: JSON.stringify({ error: 'Rule not found.' }) };
        if (existing.workspaceId !== orgId) {
            return { statusCode: 403, body: JSON.stringify({ error: 'Access denied.' }) };
        }
        // A workspace-wide rule is every assistant's: only owners and admins change it, in any way.
        if (existing.assistantId === null && !canManageWorkspace) return forbidden();

        // Moving between "this assistant" and "every assistant" (FR#10).
        let nextAssistantId: number | null | undefined;
        if (body.scope !== undefined) {
            const scope = parseRuleScope(body.scope);
            if (scope === 'workspace') {
                if (!canManageWorkspace) return forbidden();
                nextAssistantId = null;
            } else if (existing.assistantId === null) {
                const target = Number(body.assistantId);
                if (!Number.isInteger(target)) return { statusCode: 400, body: JSON.stringify({ error: 'assistantId is required to make this rule one assistant\'s.' }) };
                const [a] = await db.select({ orgId: aiAssistants.organisationId }).from(aiAssistants).where(eq(aiAssistants.id, target)).limit(1);
                if (!a || a.orgId !== orgId) return { statusCode: 404, body: JSON.stringify({ error: 'Assistant not found.' }) };
                nextAssistantId = target;
            }
        }

        if (ruleText !== undefined && ruleText.trim().length > 300) {
            return { statusCode: 400, body: JSON.stringify({ error: 'ruleText must be 300 characters or fewer.' }) };
        }

        const updates: Record<string, any> = { updatedAt: new Date(), updatedBy: userId };
        if (ruleText !== undefined) {
            updates.previousText = existing.ruleText;
            updates.ruleText = ruleText.trim();
        }
        if (platform !== undefined) updates.platform = platform || null;
        if (category !== undefined) updates.category = category?.trim() || null;
        if (note !== undefined) updates.note = note?.trim() || null;
        if (isActive !== undefined) updates.isActive = Boolean(isActive);
        if (nextAssistantId !== undefined) {
            updates.assistantId = nextAssistantId;
            // Platform scoping is a Social Media Assistant idea; a rule for every assistant has none.
            if (nextAssistantId === null) updates.platform = null;
        }

        const [updated] = await db.update(contentRules)
            .set(updates)
            .where(eq(contentRules.id, Number(id)))
            .returning();

        await recompileForRule(db, orgId, existing.assistantId, nextAssistantId === undefined ? existing.assistantId : nextAssistantId, userId, 'edit');

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rule: { ...updated, scope: ruleScopeOf(updated) } }),
        };
    }

    // ── DELETE — hard delete ──────────────────────────────────────────────────
    if (method === 'DELETE') {
        const id = params.id ? Number(params.id) : NaN;
        if (isNaN(id)) return { statusCode: 400, body: JSON.stringify({ error: 'id is required.' }) };

        // assistantId comes back too — the row is gone by the time we recompile, so it has to be
        // captured before the delete.
        const [existing] = await db.select({ workspaceId: contentRules.workspaceId, assistantId: contentRules.assistantId })
            .from(contentRules)
            .where(eq(contentRules.id, id))
            .limit(1);
        if (!existing) return { statusCode: 404, body: JSON.stringify({ error: 'Rule not found.' }) };
        if (existing.workspaceId !== orgId) {
            return { statusCode: 403, body: JSON.stringify({ error: 'Access denied.' }) };
        }
        if (existing.assistantId === null && !canManageWorkspace) return forbidden();

        await db.delete(contentRules).where(eq(contentRules.id, id));

        await recompileForRule(db, orgId, existing.assistantId, existing.assistantId, userId, 'delete');

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deleted: true, id }),
        };
    }

    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
});
