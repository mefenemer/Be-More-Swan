// src/utils/assistant-model.ts
// Which Claude model an assistant ROLE runs on — the admin's choice from Admin ▸ Assistants ▸ Model &
// rules (db/assistant-model-settings.sql), or the model written in the code when there is none.
//
// What reads it — the list on the admin page is ROLE_MODEL_PATHS (src/config/assistant-prompt-layers.ts):
// every chat (chat-orchestrator); social drafting (process-content-jobs → ai-gateway); email
// (newsletter-generate, and Email Studio flows in newsletter-campaign-generate); blog (blog-generate);
// Lead Generator (lead-generation, and discovery-scoring: the classifier, bulk scoring and the deep
// re-score); Mystery Shopper audits (site-audit); Website drafting, import and own-words rewrites
// (site-store, site-import-store); Brand Designer art direction (visual-briefs). Everything else —
// reviews, hooks, helpers, the public site-audit taster — stays on its own model.
//
// ⚠️ It must never be the reason a customer's assistant stops working. So: a missing table, a read
// error or an unknown model is "no choice" (the code default); and a chosen model the API refuses
// (400) is logged and the call is retried once on the default — see withRoleModel().

import Anthropic from '@anthropic-ai/sdk';
import { sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { effectiveThinking, modelOption, type ThinkingLevel } from '../config/model-options';

type Db = ReturnType<typeof getDb>;

export interface RoleModelChoice { model: string; thinking: ThinkingLevel }

// Read on every model call, so cached briefly per function instance. A change on the admin page
// reaches every instance within a minute; the instance that saved it, at once.
const TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: RoleModelChoice | null }>();

export function clearRoleModelCache(roleKey?: string): void {
    if (roleKey) cache.delete(roleKey); else cache.clear();
}

/** The admin's choice for a role, or null (no row, no table, or a model no longer offered). Never throws. */
export async function loadRoleModel(db: Db, roleKey: string | null | undefined): Promise<RoleModelChoice | null> {
    if (!roleKey) return null;
    const hit = cache.get(roleKey);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    let value: RoleModelChoice | null = null;
    try {
        const [row] = await db.execute<{ model: string; thinking: string }>(sql`SELECT model, thinking FROM assistant_model_settings WHERE role_key = ${roleKey} LIMIT 1`);
        if (row?.model && modelOption(row.model)) value = { model: row.model, thinking: effectiveThinking(row.model, row.thinking as ThinkingLevel) };
    } catch (err) {
        // 42P01 = the SQL file isn't applied yet: that IS "no choice", quietly.
        if ((err as { code?: string; cause?: { code?: string } })?.code !== '42P01'
            && (err as { cause?: { code?: string } })?.cause?.code !== '42P01') {
            console.error('[assistant-model] could not read the role model; using the code default', err);
        }
    }
    cache.set(roleKey, { at: Date.now(), value });
    return value;
}

/** The role key of a hired assistant, for paths that only hold its id. Null when unknown. Never throws. */
export async function roleKeyOfAssistant(db: Db, assistantId: number | null | undefined): Promise<string | null> {
    if (!assistantId) return null;
    try {
        const [row] = await db.execute<{ role_key: string }>(sql`SELECT m.role_key FROM ai_assistants a JOIN master_assistants m ON m.id = a.master_assistant_id WHERE a.id = ${assistantId} LIMIT 1`);
        return row?.role_key ?? null;
    } catch { return null; }
}

/**
 * The role's choice as fields to spread into a gatewayGenerate() request ({} = the gateway's own
 * model). The gateway adapts the request and falls back on a refusal itself. On a request path the
 * thinking is held at Low and a deadline is set, which keeps the client's 24s timeout instead of the
 * 2 minutes a thinking model gets in background work.
 */
export async function gatewayRoleModel(
    db: Db, roleKey: string | null | undefined, opts: { requestPath?: boolean } = {},
): Promise<{ model?: string; thinking?: ThinkingLevel; deadlineMs?: number }> {
    const c = await loadRoleModel(db, roleKey);
    if (!c) return {};
    if (!opts.requestPath) return { model: c.model, thinking: c.thinking };
    return { model: c.model, thinking: c.thinking === 'medium' || c.thinking === 'high' ? 'low' : c.thinking, deadlineMs: 22_000 };
}

/** A refusal of the REQUEST (wrong params for this model), not a billing or rate problem. */
function isModelRequestError(err: unknown): boolean {
    return err instanceof Anthropic.BadRequestError && !/credit balance|billing|quota/i.test(String(err.message));
}

/**
 * Run a model call on the role's model, falling back to the code default if the API refuses the
 * request for that model. `run(model, thinking)` is the caller's own call. With no choice made, it
 * runs once on `defaultModel` with thinking off — identical to the code before this existed.
 *
 * `requestPath`: a call inside a 26-second request (chat, lead outreach) is held at 'low' thinking
 * whatever the setting — the head-to-head measured Opus 5.5 at up to 22.6s on default effort.
 */
export async function withRoleModel<T>(
    choice: RoleModelChoice | null,
    defaultModel: string,
    run: (model: string, thinking: ThinkingLevel) => Promise<T>,
    opts: { requestPath?: boolean; label?: string } = {},
): Promise<T> {
    if (!choice || choice.model === defaultModel) return run(defaultModel, 'off');
    const thinking = opts.requestPath && (choice.thinking === 'medium' || choice.thinking === 'high') ? 'low' : choice.thinking;
    try {
        return await run(choice.model, thinking);
    } catch (err) {
        if (!isModelRequestError(err)) throw err;
        console.error(`[assistant-model] ${opts.label ?? 'call'}: ${choice.model} refused the request; retrying on ${defaultModel}`, err instanceof Error ? err.message : err);
        return run(defaultModel, 'off');
    }
}
