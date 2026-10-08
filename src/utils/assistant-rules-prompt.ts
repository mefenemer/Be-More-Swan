// src/utils/assistant-rules-prompt.ts
// The user's rules for an assistant, as a block for its CHAT prompt. Read every turn by
// chat-orchestrator.ts for the roles in RULE_READING_ROLES.
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
// ── The posts roles too (2026-10-07) ────────────────────────────────────────────────────────────
// The Social Media Manager and Blog Writer get their rules through blueprint §4 — but only in the
// AUTOPILOT drafting worker. A post or article drafted in chat ("write me a LinkedIn post about…")
// never saw them, while the Rules tab told the user "Changes apply to everything this assistant
// does". Both roles now read the same rules here. Same SET as §4 (src/utils/blueprint.ts): the
// assistant's own rules AND the workspace-wide ones (assistant_id NULL), with platform-only rules
// labelled so a LinkedIn rule is not applied to an Instagram caption.
//
// ⚠️ Deliberately NOT every role. Leads have their own evidence path (lead_reject_feedback) and
// their own consumer; Email Marketing's Rules tab says its rules don't steer it, and nothing here
// should quietly make that untrue. Widen RULE_READING_ROLES only together with the Rules-tab copy.

import { and, desc, eq, isNull, or } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { contentRules } from '../../db/schema';

/** Roles whose chat prompt carries their rules: the chat-only records roles, and the posts roles. */
export const RULE_READING_ROLES: ReadonlySet<string> = new Set([
    'tier1_support_agent', 'meeting_note_taker', 'accounts_receivable_clerk',
    'social_media_manager', 'blog_writer',
]);

/** Record types those roles produce. Rejecting one of these may carry a free-text `feedback`. */
export const FEEDBACK_RECORD_TYPES: ReadonlySet<string> = new Set(['ticket', 'meeting', 'invoice']);

const MAX_RULES = 40;
const MAX_BLOCK_CHARS = 4000;

export interface PromptRule { ruleText: string; origin: string | null; platform?: string | null }

const PLATFORM_LABELS: Record<string, string> = {
    instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn', x: 'X', twitter: 'X',
    tiktok: 'TikTok', threads: 'Threads', youtube: 'YouTube', pinterest: 'Pinterest', blog: 'blog articles',
};

/** Pure: the prompt block, or null when there is nothing to say. Newest rules first, capped. */
export function formatRulesBlock(rules: PromptRule[]): string | null {
    const lines: string[] = [];
    let used = 0;
    for (const r of rules) {
        const text = String(r.ruleText || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const p = String(r.platform || '').trim().toLowerCase();
        const scope = p && p !== 'global' ? ` [only for ${PLATFORM_LABELS[p] ?? p}]` : '';
        const line = `- ${text}${scope}${r.origin === 'rejection_feedback' ? ' (from feedback on something you produced that they rejected)' : ''}`;
        if (used + line.length > MAX_BLOCK_CHARS) break;
        lines.push(line);
        used += line.length;
    }
    if (!lines.length) return null;
    return `RULES FROM YOUR USER — follow every one of these in everything you produce for them: posts, captions, articles, replies, tickets, summaries, action items, reminders and tables. A rule marked [only for …] applies only to that platform. Where a rule conflicts with your default behaviour, the rule wins. If a rule stops you doing part of what they asked, say so in one short sentence AND still produce the work without that part, in your normal format — never reply with the explanation alone. Never mention that you were given rules.\n${lines.join('\n')}`;
}

/** The active rules for one assistant, as a prompt block. Never throws: a failed read means no block. */
export async function loadAssistantRulesBlock(
    db: PostgresJsDatabase<any>,
    params: { assistantId: number; organisationId: number },
): Promise<string | null> {
    try {
        // The same set blueprint §4 gives autopilot: this assistant's rules plus the workspace-wide
        // ones (assistant_id NULL). Reading only the first left chat behind autopilot.
        const rows = await db.select({ ruleText: contentRules.ruleText, origin: contentRules.origin, platform: contentRules.platform })
            .from(contentRules)
            .where(and(
                or(eq(contentRules.assistantId, params.assistantId), isNull(contentRules.assistantId)),
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
