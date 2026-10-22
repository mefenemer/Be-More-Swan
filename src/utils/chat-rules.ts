// src/utils/chat-rules.ts
// Every assistant chat's view of, and hands on, its own Do's and don'ts: the rules listed by "#id"
// (on and off), and a card to add one, reword one, switch one off or on, or delete one.
//
// ── Why ──────────────────────────────────────────────────────────────────────────────────────────
// Every capability is meant to be reachable from the GUI and from chat, through the same server
// action. The chat FOLLOWED the rules (assistant-rules-prompt.ts) but was told never to mention them,
// and could not change one: "from now on never use exclamation marks" was obeyed for one reply and
// forgotten, because nothing saved it. The page's Do's and don'ts card was the only way.
//
// ── How ──────────────────────────────────────────────────────────────────────────────────────────
// Same contract as chat-assistant-settings.ts. The model never acts. It proposes a `rule_proposal`;
// this module checks it against content_rules — an existing rule must be THIS assistant's own (a
// workspace-wide rule, assistant_id NULL, applies to every assistant and is not changed from one
// assistant's chat), the text must fit the page's 300-character limit — and rebuilds the card from
// the row. The click (chat-session.js) calls content-rules.ts, the endpoint the Do's and don'ts card
// uses (POST create, PATCH edit / toggle, DELETE), which recompiles the brief so a change reaches
// autopilot too. Nothing here writes.
//
// ⚠️ Never throws.

import { and, desc, eq, isNull, or } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { contentRules } from '../../db/schema';

type Db = ReturnType<typeof getDb>;

export const RULE_PROPOSAL_TYPE = 'rule_proposal';
export const RULE_ACTIONS = ['add', 'edit', 'turn_off', 'turn_on', 'delete'] as const;
export type RuleAction = typeof RULE_ACTIONS[number];

/** content-rules.ts refuses longer text. */
export const RULE_TEXT_MAX = 300;
const LIST_MAX = 40;

/** Platforms a Social Media Assistant rule can be limited to (the Do's and don'ts scope picker). */
export const RULE_PLATFORMS = ['instagram', 'facebook', 'linkedin', 'x', 'tiktok', 'threads', 'youtube', 'pinterest'] as const;
const PLATFORM_LABEL: Record<string, string> = {
    instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn', x: 'X', tiktok: 'TikTok',
    threads: 'Threads', youtube: 'YouTube', pinterest: 'Pinterest', blog: 'blog articles',
};
const ORIGIN_WORDS: Record<string, string> = {
    rejection_feedback: 'from something they rejected', tuning: 'from a tuning session',
    campaign_learning: 'a lesson from a campaign', onboarding: 'from setup',
};

const oneLine = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();

// ── Read ─────────────────────────────────────────────────────────────────────────────────────────

/** The rules by id, for this turn's prompt. Never throws. */
export async function buildRulesListBlock(db: Db, organisationId: number, aiAssistantId: number): Promise<string> {
    try {
        const rows = await db.select({
            id: contentRules.id, ruleText: contentRules.ruleText, isActive: contentRules.isActive,
            platform: contentRules.platform, origin: contentRules.origin, assistantId: contentRules.assistantId,
        })
            .from(contentRules)
            .where(and(
                eq(contentRules.workspaceId, organisationId),
                or(eq(contentRules.assistantId, aiAssistantId), isNull(contentRules.assistantId)),
            ))
            .orderBy(desc(contentRules.createdAt))
            .limit(LIST_MAX);
        const line = (r: typeof rows[number]) => {
            const p = oneLine(r.platform).toLowerCase();
            const scope = p && p !== 'global' ? ` [only for ${PLATFORM_LABEL[p] ?? p}]` : '';
            const origin = r.origin && ORIGIN_WORDS[r.origin] ? ` (${ORIGIN_WORDS[r.origin]})` : '';
            return `- #${r.id} ${r.isActive ? 'ON' : 'OFF'}: ${oneLine(r.ruleText)}${scope}${origin}`;
        };
        const own = rows.filter((r) => r.assistantId === aiAssistantId);
        const shared = rows.filter((r) => r.assistantId == null);
        return [
            'YOUR DO’S AND DON’TS (Assistant Profile ▸ Do’s and don’ts), by "#" number, read this turn. ON rules are the ones you follow; OFF rules are kept but switched off:',
            own.length ? own.map(line).join('\n') : '- none yet',
            shared.length ? `Workspace-wide rules (they apply to every assistant, and are not changed from this chat):\n${shared.map(line).join('\n')}` : '',
        ].filter(Boolean).join('\n');
    } catch (err) {
        console.error('[chat-rules] rules list read failed (non-fatal)', err);
        return 'YOUR DO’S AND DON’TS: could not be read this turn — if asked, say so; never guess what the rules are.';
    }
}

/** The prompt section that lets a structured route propose a rule change. */
export function rulesPromptBlock(roleKey: string | null | undefined): string {
    const platformLine = roleKey === 'social_media_manager'
        ? `, "platform": null | ${RULE_PLATFORMS.map((p) => `"${p}"`).join(' | ')}   (null = every platform; only when the user limits it to one)`
        : '';
    return `CHANGING YOUR DO’S AND DON’TS — when the user asks you to remember something for the future ("from now on…", "never…", "always…", "stop doing…"), to reword a rule, to switch one off or back on, or to delete one, put this in "uiElement" instead of anything else (one change per reply):
{ "type": "rule_proposal", "action": "add", "ruleText": "<the rule, short and general, in the user's terms, at most ${RULE_TEXT_MAX} characters>"${platformLine} }
{ "type": "rule_proposal", "action": "edit", "ruleId": <# number>, "ruleText": "<the new wording>" }
{ "type": "rule_proposal", "action": "turn_off" | "turn_on" | "delete", "ruleId": <# number> }
Name a rule only by a # number listed under YOUR DO’S AND DON’TS, and only one of your own (not a workspace-wide one). Prefer "turn_off" when they want to stop a rule for now; "delete" only when they say to remove it for good. A request that is only about the reply in front of you ("make this one shorter") is not a rule — just do it. You never change a rule yourself: the user confirms on the card, and only that click saves it. So never say a rule HAS been saved, changed or removed — say the card is there to confirm. If they ask what your rules are, list them from above.`;
}

// ── Propose ──────────────────────────────────────────────────────────────────────────────────────

export interface RuleRequest {
    action: RuleAction;
    ruleId: number | null;
    ruleText: string | null;
    platform: string | null;
}

/** Shape check on the model's output. Pure. Null when it is not a usable proposal. */
export function ruleProposalFromUiElement(uiElement: unknown): RuleRequest | null {
    if (!uiElement || typeof uiElement !== 'object') return null;
    const ui = uiElement as Record<string, unknown>;
    if (ui.type !== RULE_PROPOSAL_TYPE) return null;
    const action = RULE_ACTIONS.find((a) => a === ui.action);
    if (!action) return null;
    const text = typeof ui.ruleText === 'string' ? oneLine(ui.ruleText) : '';
    const id = Number(String(ui.ruleId ?? '').replace(/^#/, ''));
    const platform = RULE_PLATFORMS.find((p) => p === ui.platform) ?? null;
    if (action === 'add') return text ? { action, ruleId: null, ruleText: text, platform } : null;
    if (!Number.isInteger(id) || id <= 0) return null;
    if (action === 'edit') return text ? { action, ruleId: id, ruleText: text, platform: null } : null;
    return { action, ruleId: id, ruleText: null, platform: null };
}

export interface RuleCard {
    type: typeof RULE_PROPOSAL_TYPE;
    action: RuleAction;
    assistantId: number;
    ruleId: number | null;
    /** The rule as it is now (edit / turn_off / turn_on / delete). */
    currentText: string | null;
    /** The text the click saves (add / edit). */
    ruleText: string | null;
    platform: string | null;
    platformLabel: string | null;
    isActive: boolean | null;
    blocked: string | null;
    settled?: boolean;
}

interface RuleRow { id: number; ruleText: string; isActive: boolean; platform: string | null; assistantId: number | null }

async function readRule(db: Db, organisationId: number, ruleId: number): Promise<RuleRow | null> {
    const [row] = await db.select({
        id: contentRules.id, ruleText: contentRules.ruleText, isActive: contentRules.isActive,
        platform: contentRules.platform, assistantId: contentRules.assistantId,
    })
        .from(contentRules)
        .where(and(eq(contentRules.id, ruleId), eq(contentRules.workspaceId, organisationId)))
        .limit(1);
    return row ?? null;
}

function buildRuleCard(aiAssistantId: number, roleKey: string | null | undefined, req: RuleRequest, row: RuleRow | null): RuleCard {
    const platform = roleKey === 'social_media_manager' ? req.platform : null;
    const card: RuleCard = {
        type: RULE_PROPOSAL_TYPE,
        action: req.action,
        assistantId: aiAssistantId,
        ruleId: req.ruleId,
        currentText: row ? oneLine(row.ruleText) : null,
        ruleText: req.ruleText,
        platform: req.action === 'add' ? platform : (row?.platform ?? null),
        platformLabel: null,
        isActive: row ? row.isActive : null,
        blocked: null,
    };
    const p = oneLine(card.platform).toLowerCase();
    card.platformLabel = p && p !== 'global' ? (PLATFORM_LABEL[p] ?? p) : null;
    if (req.ruleText && req.ruleText.length > RULE_TEXT_MAX) {
        card.blocked = `A rule can be at most ${RULE_TEXT_MAX} characters. Ask for a shorter one.`;
        return card;
    }
    if (req.action === 'add') return card;
    if (!row) { card.blocked = 'That rule no longer exists.'; return card; }
    if (row.assistantId == null) { card.blocked = 'That is a workspace-wide rule for every assistant, so it isn’t changed from this chat.'; return card; }
    if (row.assistantId !== aiAssistantId) { card.blocked = 'That rule belongs to a different assistant.'; return card; }
    if (req.action === 'turn_off' && !row.isActive) card.blocked = 'That rule is already switched off.';
    if (req.action === 'turn_on' && row.isActive) card.blocked = 'That rule is already on.';
    if (req.action === 'edit' && oneLine(row.ruleText) === req.ruleText) card.blocked = 'That rule already says exactly that.';
    return card;
}

/** Check a proposal against content_rules and return the card. Null when the read fails. */
export async function resolveRuleProposal(
    db: Db, organisationId: number, aiAssistantId: number, roleKey: string | null | undefined, req: RuleRequest,
): Promise<RuleCard | null> {
    try {
        const row = req.ruleId ? await readRule(db, organisationId, req.ruleId) : null;
        return buildRuleCard(aiAssistantId, roleKey, req, row);
    } catch (err) {
        console.error('[chat-rules] could not resolve the proposal (non-fatal)', err);
        return null;
    }
}

// ── Reopening a conversation ─────────────────────────────────────────────────────────────────────
// The endpoint makes a new row on every "add", so a stored add card is closed once this assistant has
// a rule with that exact text — otherwise a reload would offer the button again and save it twice.
// Cards on an existing rule are re-checked against the row.

/** Re-check every stored rule_proposal on an existing rule. Mutates nothing it is given. */
export async function refreshRuleCards<M extends { uiElement: unknown }>(
    db: Db, organisationId: number, aiAssistantId: number, roleKey: string | null | undefined, messages: M[],
): Promise<M[]> {
    return Promise.all(messages.map(async (m) => {
        const ui = m.uiElement as Record<string, unknown> | null;
        if (!ui || ui.type !== RULE_PROPOSAL_TYPE) return m;
        const req = ruleProposalFromUiElement(ui);
        if (!req) return m;
        try {
            if (req.action === 'add') {
                const [saved] = await db.select({ id: contentRules.id }).from(contentRules)
                    .where(and(eq(contentRules.workspaceId, organisationId), eq(contentRules.assistantId, aiAssistantId), eq(contentRules.ruleText, req.ruleText!)))
                    .limit(1);
                return saved ? { ...m, uiElement: { ...ui, ruleId: saved.id, settled: true, blocked: `Saved — it’s rule #${saved.id}.` } } : m;
            }
            if (!req.ruleId) return m;
            const row = await readRule(db, organisationId, req.ruleId);
            const now = buildRuleCard(aiAssistantId, roleKey, req, row);
            if (!now.blocked) return { ...m, uiElement: { ...ui, currentText: now.currentText, isActive: now.isActive } };
            return { ...m, uiElement: { ...ui, settled: true, blocked: now.blocked } };
        } catch (err) {
            console.error('[chat-rules] could not refresh a stored card (non-fatal)', err);
            return m;
        }
    }));
}
