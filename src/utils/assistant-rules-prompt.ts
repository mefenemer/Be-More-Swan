// src/utils/assistant-rules-prompt.ts
// The user's rules for an assistant, as a block for the CHAT prompt of the assistants whose only
// producer is chat: Tier 1 Support, Meeting Note Taker and the AR Clerk.
//
// ── Why ─────────────────────────────────────────────────────────────────────────────────────────
// content_rules reach a model through ONE path: blueprint §4, read by the social/blog drafting
// worker. These three roles have no drafting worker. Every ticket triage, meeting summary and
// aging-invoices table they produce comes out of a chat turn (chat-orchestrator.ts
// hubRecordsFromUiElement → assistant_records), and the chat prompt never opened content_rules.
// So the Assistant Rules a user typed for them, and anything they said when rejecting a record,
// reached nothing: the assistant made the same mistake forever.
//
// This module is the missing reader for those roles, plus the vocabulary that ties a record type
// back to the role whose chat produced it. The writer is the records reject path
// (assistant-records.ts PATCH, `feedback`), which saves the reason as a `rejection_feedback` rule.
//
// ⚠️ Deliberately NOT every role. Leads have their own evidence path (lead_reject_feedback) and
// their own consumer; posts roles get rules via §4 already. Widen RULE_READING_ROLES only for a
// role whose records really are produced by chat.

import { and, desc, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { contentRules } from '../../db/schema';

/** Roles whose records come from chat, so their chat prompt must carry their rules. */
export const RULE_READING_ROLES: ReadonlySet<string> = new Set([
    'tier1_support_agent', 'meeting_note_taker', 'accounts_receivable_clerk',
]);

/** Record types those roles produce. Rejecting one of these may carry a free-text `feedback`. */
export const FEEDBACK_RECORD_TYPES: ReadonlySet<string> = new Set(['ticket', 'meeting', 'invoice']);

const MAX_RULES = 40;
const MAX_BLOCK_CHARS = 4000;

export interface PromptRule { ruleText: string; origin: string | null }

/** Pure: the prompt block, or null when there is nothing to say. Newest rules first, capped. */
export function formatRulesBlock(rules: PromptRule[]): string | null {
    const lines: string[] = [];
    let used = 0;
    for (const r of rules) {
        const text = String(r.ruleText || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const line = `- ${text}${r.origin === 'rejection_feedback' ? ' (from feedback on something you produced that they rejected)' : ''}`;
        if (used + line.length > MAX_BLOCK_CHARS) break;
        lines.push(line);
        used += line.length;
    }
    if (!lines.length) return null;
    return `RULES FROM YOUR USER — follow every one of these in everything you produce for them, including tickets, summaries, action items, reminders and tables. Where a rule conflicts with your default behaviour, the rule wins. Never mention that you were given rules.\n${lines.join('\n')}`;
}

/** The active rules for one assistant, as a prompt block. Never throws: a failed read means no block. */
export async function loadAssistantRulesBlock(
    db: PostgresJsDatabase<any>,
    params: { assistantId: number; organisationId: number },
): Promise<string | null> {
    try {
        const rows = await db.select({ ruleText: contentRules.ruleText, origin: contentRules.origin })
            .from(contentRules)
            .where(and(
                eq(contentRules.assistantId, params.assistantId),
                eq(contentRules.workspaceId, params.organisationId),
                eq(contentRules.isActive, true),
            ))
            .orderBy(desc(contentRules.createdAt))
            .limit(MAX_RULES);
        return formatRulesBlock(rows);
    } catch (err) {
        console.error('[assistant-rules-prompt] could not load rules — this turn runs without them', err);
        return null;
    }
}
