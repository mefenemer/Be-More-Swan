// src/utils/workspace-rules.ts
// Workspace-wide Do's and don'ts: one rule every assistant follows (FR#10, owner 2026-11-11).
//
// ── What already existed ─────────────────────────────────────────────────────────────────────────
// A content_rules row with assistant_id NULL has always been read by every assistant: blueprint §4
// (autopilot), assistant-rules-prompt.ts (chat and the records roles) and chat-rules.ts (the chat's
// own list). Nothing could CREATE one, so the readers only ever saw rows a migration had left.
//
// ── What this adds ───────────────────────────────────────────────────────────────────────────────
// One rule for who may make or change them, shared by the endpoint (content-rules.ts), the chat's
// rule card (chat-rules.ts) and the page (assistants.js gets it back from the GET as
// canManageWorkspaceRules). Owners and admins only: an invited member can be limited to some
// assistants (member-assistant-access), and a rule they set must not reach assistants they can't see.
//
// Pure. No database access.

/** Where a rule applies. 'workspace' = assistant_id NULL = every assistant in the workspace. */
export type RuleScope = 'assistant' | 'workspace';

export const WORKSPACE_RULE_ROLES: readonly string[] = ['owner', 'admin'];

/** May this workspace role add, change, switch off or delete a rule for every assistant? */
export function canManageWorkspaceRules(role: string | null | undefined): boolean {
    return typeof role === 'string' && WORKSPACE_RULE_ROLES.includes(role);
}

/** The scope a stored row has. */
export function ruleScopeOf(row: { assistantId: number | null | undefined }): RuleScope {
    return row.assistantId == null ? 'workspace' : 'assistant';
}

/** A scope from an untrusted body: only the exact string 'workspace' widens it. */
export function parseRuleScope(v: unknown): RuleScope {
    return v === 'workspace' ? 'workspace' : 'assistant';
}

export const WORKSPACE_RULE_FORBIDDEN =
    'Only the workspace owner or an admin can set or change a rule that applies to every assistant.';
