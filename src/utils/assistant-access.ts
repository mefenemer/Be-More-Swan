// src/utils/assistant-access.ts
// Which assistants a teammate can use.
//
// user_organisations.assistant_ids: NULL = every assistant in the workspace, a list = only those.
// Owners and admins always have every assistant, whatever the column holds, because they can change
// anyone's access anyway. Every membership before db/z-member-assistant-access.sql is NULL.
//
// tenant.ts enforces it: a request from a limited teammate that names an assistant outside their
// list is refused there, before the function runs. Lists (get-assistants.ts) filter with
// filterToAccessible. Pure: no database.

/** Roles that always see every assistant. */
const FULL_ACCESS_ROLES = new Set(['owner', 'admin']);

/** null = every assistant. */
export type AssistantAccess = number[] | null;

/** The access a membership row grants. Owners and admins always get every assistant. */
export function accessForMembership(role: string, assistantIds: unknown): AssistantAccess {
    if (FULL_ACCESS_ROLES.has(role)) return null;
    if (!Array.isArray(assistantIds)) return null;
    return assistantIds.map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

export function canAccessAssistant(access: AssistantAccess, assistantId: number): boolean {
    return access === null || access.includes(assistantId);
}

export function filterToAccessible<T extends { id: number }>(access: AssistantAccess, rows: T[]): T[] {
    return access === null ? rows : rows.filter((r) => access.includes(r.id));
}

/**
 * What an invite or role change asks for, checked against the workspace's own assistants.
 * Returns null for "every assistant" (owners and admins, or no list sent), a list of ids, or an
 * error message. A limited teammate must have at least one assistant.
 */
export function parseRequestedAccess(
    role: string,
    requested: unknown,
    workspaceAssistantIds: number[],
): { access: AssistantAccess } | { error: string } {
    if (FULL_ACCESS_ROLES.has(role) || requested === undefined || requested === null || requested === 'all') {
        return { access: null };
    }
    if (!Array.isArray(requested)) return { error: 'Choose which assistants they can use.' };
    const ids = [...new Set(requested.map(Number))];
    if (ids.some((n) => !Number.isInteger(n) || n <= 0)) return { error: 'Choose which assistants they can use.' };
    if (ids.length === 0) return { error: 'Choose at least one assistant for them to use.' };
    const own = new Set(workspaceAssistantIds);
    if (ids.some((n) => !own.has(n))) return { error: 'One of those assistants is not in this workspace.' };
    // Every assistant ticked is stored as a list, not NULL, so an assistant hired later isn't
    // handed to them without anyone choosing it.
    return { access: ids.sort((a, b) => a - b) };
}

// ── Finding the assistant a request names ──────────────────────────────────────────────────────

/** Query and body keys that always mean an ai_assistants id. */
const ASSISTANT_KEYS = ['assistantId', 'assistant_id', 'aiAssistantId', 'ai_assistant_id'];
const ASSISTANT_LIST_KEYS = ['assistantIds', 'assistant_ids'];

/** Functions whose `?id=` is an assistant id. */
const ID_IS_ASSISTANT = new Set([
    'manage-assistant',
    'get-assistant-metrics',
    'get-assistant-context',
    'get-assistant-readiness',
    'get-assistant-performance',
    'kickoff-assistant',
    'retry-provision-assistant',
    'get-lead-roi',
    'get-lead-performance',
    'get-campaign-performance',
    'get-campaign-funnel',
    'get-blog-performance',
]);

interface RequestLike {
    path?: string;
    rawUrl?: string;
    queryStringParameters?: Record<string, string | undefined> | null;
    body?: string | null;
    isBase64Encoded?: boolean;
    headers?: Record<string, string | undefined>;
}

function functionName(event: RequestLike): string {
    const path = event.path || (event.rawUrl ? (() => { try { return new URL(event.rawUrl!).pathname; } catch { return ''; } })() : '');
    return path.replace(/\/+$/, '').split('/').pop() || '';
}

function pushId(out: number[], v: unknown): void {
    const n = Number(v);
    if (Number.isInteger(n) && n > 0) out.push(n);
}

/** Every assistant id the request names in its query string or JSON body. */
export function assistantIdsInRequest(event: RequestLike): number[] {
    const out: number[] = [];
    const qs = event.queryStringParameters || {};
    for (const k of ASSISTANT_KEYS) if (qs[k] != null && qs[k] !== '') pushId(out, qs[k]);
    if (qs.id && ID_IS_ASSISTANT.has(functionName(event))) pushId(out, qs.id);

    if (event.body && !event.isBase64Encoded) {
        const text = event.body.trimStart();
        if (text.startsWith('{')) {
            let body: Record<string, unknown> | null = null;
            try { body = JSON.parse(text); } catch { body = null; }
            if (body && typeof body === 'object') {
                for (const k of ASSISTANT_KEYS) if (body[k] != null && body[k] !== '') pushId(out, body[k]);
                for (const k of ASSISTANT_LIST_KEYS) {
                    if (Array.isArray(body[k])) for (const v of body[k] as unknown[]) pushId(out, v);
                }
            }
        }
    }
    return [...new Set(out)];
}

/** The first assistant the request names that this access doesn't include, or null. */
export function firstBlockedAssistant(access: AssistantAccess, event: RequestLike): number | null {
    if (access === null) return null;
    for (const id of assistantIdsInRequest(event)) if (!access.includes(id)) return id;
    return null;
}
