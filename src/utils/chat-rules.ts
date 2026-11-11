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
// this module checks it against content_rules — an existing rule must be THIS assistant's own, or a
// workspace-wide one (assistant_id NULL, followed by every assistant), which only an owner or admin
// may add or change (FR#10, src/utils/workspace-rules.ts); the text must fit the page's
// 300-character limit — and rebuilds the card from the row. The click (chat-session.js) calls content-rules.ts, the endpoint the Do's and don'ts card
// uses (POST create, PATCH edit / toggle, DELETE), which recompiles the brief so a change reaches
// autopilot too. Nothing here writes.
//
// ⚠️ Never throws.

import { and, desc, eq, isNull, or } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { contentRules } from '../../db/schema';
import { WORKSPACE_RULE_FORBIDDEN, type RuleScope } from './workspace-rules';

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
            'YOUR DO’S AND DON’TS (Assistant Settings ▸ Do’s and don’ts), by "#" number, read this turn. ON rules are the ones you follow; OFF rules are kept but switched off:',
            own.length ? own.map(line).join('\n') : '- none yet',
            shared.length ? `Workspace-wide rules (every one of their assistants follows these; changing one changes it for all of them):\n${shared.map(line).join('\n')}` : '',
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
{ "type": "rule_proposal", "action": "add", "ruleText": "<the rule, short and general, in the user's terms — one or two sentences, well under ${RULE_TEXT_MAX} characters>"${platformLine} }
Add "scope": "workspace" to an "add" ONLY when the user says it should apply to all their assistants, every assistant or the whole team; then every one of their assistants follows it, and it has no platform. Without it, the rule is yours alone.
{ "type": "rule_proposal", "action": "edit", "ruleId": <# number>, "ruleText": "<the new wording>" }
{ "type": "rule_proposal", "action": "turn_off" | "turn_on" | "delete", "ruleId": <# number> }
A rule is one point, not a brief: when they give you longer guidance (for a content pillar, say), propose its most important point as this rule and offer to add the others one at a time. Name a rule only by a # number listed under YOUR DO’S AND DON’TS — your own or a workspace-wide one. Changing a workspace-wide rule changes it for every assistant: say so. Only the workspace owner or an admin can add or change a workspace-wide rule; the card says so if this user can't. Prefer "turn_off" when they want to stop a rule for now; "delete" only when they say to remove it for good. A request that is only about the reply in front of you ("make this one shorter") is not a rule — just do it. You never change a rule yourself: the user confirms on the card, and only that click saves it. So never say a rule HAS been saved, changed or removed — say the card is there to confirm. If they ask what your rules are, list them from above.`;
}

// ── Propose ──────────────────────────────────────────────────────────────────────────────────────

export interface RuleRequest {
    action: RuleAction;
    ruleId: number | null;
    ruleText: string | null;
    platform: string | null;
    /** add only: 'workspace' = every assistant (FR#10). Everything else is 'assistant'. */
    scope?: RuleScope;
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
    if (action === 'add') {
        if (!text) return null;
        return ui.scope === 'workspace'
            ? { action, ruleId: null, ruleText: text, platform: null, scope: 'workspace' }
            : { action, ruleId: null, ruleText: text, platform };
    }
    if (!Number.isInteger(id) || id <= 0) return null;
    if (action === 'edit') return text ? { action, ruleId: id, ruleText: text, platform: null } : null;
    return { action, ruleId: id, ruleText: null, platform: null };
}

// ── Too long ─────────────────────────────────────────────────────────────────────────────────────
// A model can't count characters: asked for "at most 300", a Social Media Assistant turning pillar
// guidance into a rule kept writing 400+, and the card refused it every time ("Ask for a shorter
// one"), so the user had to ask again and again. Now an over-long add/edit is condensed by a second,
// small model call before the card is built — up to two tries — and refused only if that still fails.

export const RULE_SHORTEN_PROMPT = `You condense one rule an AI assistant follows when it writes content. Keep its meaning, every concrete instruction, and the user's own terms; drop filler, examples and repetition. Write it as one short imperative rule of at most ${RULE_TEXT_MAX} characters — aim for about 220. Reply with the rule only: no quotes, no preamble.`;

/** Condense an over-long rule with `ask` (system, user) → text. Text that fits comes back as it is.
 *  Null when it still doesn't fit after two tries, or the call fails. Never throws. */
export async function shortenRuleText(
    text: string, ask: (system: string, user: string) => Promise<string>,
): Promise<string | null> {
    let current = oneLine(text);
    if (current.length <= RULE_TEXT_MAX) return current;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const out = oneLine(await ask(RULE_SHORTEN_PROMPT, `The rule (${current.length} characters — too long):\n"""${current.slice(0, 4000)}"""`))
                .replace(/^["“']+|["”']+$/g, '').trim();
            if (!out) return null;
            if (out.length <= RULE_TEXT_MAX) return out;
            current = out;
        } catch (err) {
            console.error('[chat-rules] could not shorten a rule (non-fatal)', err);
            return null;
        }
    }
    return null;
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
    /** 'workspace' = every assistant follows it (a new one, or the existing row is shared). */
    scope: RuleScope;
    blocked: string | null;
    settled?: boolean;
}

/** What the caller knows about the user. canManageWorkspaceRules undefined = not known (a reload):
 *  the permission is then left to the endpoint, which checks it again on the click. */
export interface RuleCardOptions { canManageWorkspaceRules?: boolean }

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

function buildRuleCard(aiAssistantId: number, roleKey: string | null | undefined, req: RuleRequest, row: RuleRow | null, opts: RuleCardOptions = {}): RuleCard {
    const scope: RuleScope = req.action === 'add' ? (req.scope === 'workspace' ? 'workspace' : 'assistant') : (row && row.assistantId == null ? 'workspace' : 'assistant');
    const platform = roleKey === 'social_media_manager' && scope !== 'workspace' ? req.platform : null;
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
        scope,
        blocked: null,
    };
    const p = oneLine(card.platform).toLowerCase();
    card.platformLabel = p && p !== 'global' ? (PLATFORM_LABEL[p] ?? p) : null;
    if (req.ruleText && req.ruleText.length > RULE_TEXT_MAX) {
        card.blocked = `A rule can be at most ${RULE_TEXT_MAX} characters, and I couldn’t shorten this one without losing something. Split it into a few shorter rules, one point each.`;
        return card;
    }
    if (scope === 'workspace' && opts.canManageWorkspaceRules === false) { card.blocked = WORKSPACE_RULE_FORBIDDEN; return card; }
    if (req.action === 'add') return card;
    if (!row) { card.blocked = 'That rule no longer exists.'; return card; }
    if (row.assistantId != null && row.assistantId !== aiAssistantId) { card.blocked = 'That rule belongs to a different assistant.'; return card; }
    if (req.action === 'turn_off' && !row.isActive) card.blocked = 'That rule is already switched off.';
    if (req.action === 'turn_on' && row.isActive) card.blocked = 'That rule is already on.';
    if (req.action === 'edit' && oneLine(row.ruleText) === req.ruleText) card.blocked = 'That rule already says exactly that.';
    return card;
}

/** Check a proposal against content_rules and return the card. Null when the read fails. */
export async function resolveRuleProposal(
    db: Db, organisationId: number, aiAssistantId: number, roleKey: string | null | undefined, req: RuleRequest,
    opts: RuleCardOptions = {},
): Promise<RuleCard | null> {
    try {
        const row = req.ruleId ? await readRule(db, organisationId, req.ruleId) : null;
        return buildRuleCard(aiAssistantId, roleKey, req, row, opts);
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
                    .where(and(
                        eq(contentRules.workspaceId, organisationId),
                        req.scope === 'workspace' ? isNull(contentRules.assistantId) : eq(contentRules.assistantId, aiAssistantId),
                        eq(contentRules.ruleText, req.ruleText!),
                    ))
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
