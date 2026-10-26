// src/utils/chat-setup-field.ts
// The `setup_field_proposal` card (docs/business-mentor-plan.md §3.4): change ONE set-up answer on an
// ACTIVE assistant. The rules are src/utils/setup-field.ts; this file builds the card from the database
// and checks the write.
//
//   Business Mentor → any active assistant in the workspace (it sees their answers in <workspace>).
//   Every other structured route → only its own answers (assistantSetupFieldBlock).
//
// The model names { assistantId, key, value }; the server rebuilds the card from the row (real label,
// real current answer, the target's name), refuses a value the question doesn't allow, an excluded
// question, a target that isn't active or isn't in this workspace, and a "change" to what is saved.
// The click (chat-session.js → window.MentorApply) PUTs update-assistant-context.ts with
// `patchContext: { [key]: value }` — the same endpoint the assistant's own profile saves through —
// and the server checks it all again there (applySetupPatch).

import { and, eq } from 'drizzle-orm';
import { aiAssistants, masterAssistants } from '../../db/schema';
import { teamState } from './mentor-snapshot';
import {
    SETUP_FIELD_CARD_TYPE, displaySetupValue, exclusionReason, patchableSetupFieldDef, renderSetupFields, sameSetupValue, setupFieldDef, validateSetupValue,
} from './setup-field';

type Db = any;

export interface SetupFieldCard {
    type: typeof SETUP_FIELD_CARD_TYPE;
    summary: string;
    /** The evidence (Mentor) or reason for the change. */
    why: string;
    asked: boolean;
    assistantId: number;
    assistantName: string;
    roleKey: string;
    key: string;
    label: string;
    currentLabel: string;
    value: string | number;
    valueLabel: string;
}

export interface SetupFieldRequest { assistantId: number | null; key: string; value: unknown; summary: string; why: string; asked: boolean }

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** The model's uiElement as a request, or null when it isn't this card. */
export function setupFieldRequestFromUiElement(ui: unknown): SetupFieldRequest | null {
    if (!ui || typeof ui !== 'object') return null;
    const u = ui as Record<string, unknown>;
    if (u.type !== SETUP_FIELD_CARD_TYPE) return null;
    const id = Number(u.assistantId);
    return {
        assistantId: Number.isInteger(id) && id > 0 ? id : null,
        key: text(u.key, 80),
        value: u.value,
        summary: text(u.summary, 300),
        why: text(u.why, 400) || text(u.reason, 400),
        asked: u.asked === true,
    };
}

/** Pure: is this row an assistant the card may change? */
export function isActiveTarget(lifecycleStatus: string | null, provisioningStatus: string | null): boolean {
    return teamState(lifecycleStatus, provisioningStatus) === 'active';
}

/**
 * Build the card from the database, or say why not. `allowOthers` = the Business Mentor (any active
 * assistant in the workspace); otherwise the target is forced to `sourceAssistantId`.
 */
export async function resolveSetupFieldProposal(
    db: Db, orgId: number, sourceAssistantId: number, req: SetupFieldRequest, opts: { allowOthers: boolean },
): Promise<SetupFieldCard | { error: string }> {
    const targetId = opts.allowOthers ? req.assistantId : sourceAssistantId;
    if (!targetId) return { error: 'It didn\'t say which assistant to change.' };
    if (!req.why) return { error: 'A change to a set-up answer needs to say why.' };
    const [row] = await db.select({
        id: aiAssistants.id, name: aiAssistants.name, roleKey: masterAssistants.roleKey, context: aiAssistants.onboardingContext,
        lifecycleStatus: aiAssistants.lifecycleStatus, provisioningStatus: aiAssistants.provisioningStatus,
    }).from(aiAssistants)
        .leftJoin(masterAssistants, eq(aiAssistants.masterAssistantId, masterAssistants.id))
        .where(and(eq(aiAssistants.id, targetId), eq(aiAssistants.organisationId, orgId)))
        .limit(1);
    if (!row) return { error: 'That assistant isn\'t in this workspace.' };
    if (!isActiveTarget(row.lifecycleStatus, row.provisioningStatus)) return { error: `${row.name || 'That assistant'} isn't active, so I can't change its set-up.` };
    const roleKey = row.roleKey ?? '';
    const excluded = exclusionReason(roleKey, req.key);
    if (excluded) return { error: `That answer is changed elsewhere: ${excluded}` };
    const def = setupFieldDef(roleKey, req.key);
    if (!def) return { error: `${row.name || 'That assistant'} has no set-up question called "${req.key}".` };
    const checked = validateSetupValue(def, req.value);
    if (!checked.ok) return { error: checked.error };
    const ctx = (row.context as Record<string, unknown> | null) ?? {};
    if (sameSetupValue(ctx[def.key], checked.value, def)) return { error: `"${def.label}" is already ${displaySetupValue(def, ctx[def.key])}, so nothing would change.` };
    return {
        type: SETUP_FIELD_CARD_TYPE,
        summary: req.summary || `Change "${def.label}" for ${row.name}`,
        why: req.why, asked: req.asked,
        assistantId: row.id, assistantName: row.name || 'Assistant', roleKey,
        key: def.key, label: def.label,
        currentLabel: displaySetupValue(def, ctx[def.key]),
        value: checked.value, valueLabel: displaySetupValue(def, checked.value),
    };
}

/**
 * Pure: the write's check, run by update-assistant-context.ts inside its transaction on the row it just
 * read. Returns the whole new context (the row's answers + only the patched keys).
 */
export function applySetupPatch(
    row: { roleKey: string; lifecycleStatus: string | null; provisioningStatus: string | null; context: Record<string, unknown> | null },
    patch: Record<string, unknown>,
): { ok: true; context: Record<string, unknown> } | { ok: false; error: string } {
    if (!isActiveTarget(row.lifecycleStatus, row.provisioningStatus)) return { ok: false, error: 'This assistant isn\'t active, so its set-up can\'t be changed from a card. Change it on its own page.' };
    const keys = Object.keys(patch);
    if (!keys.length || keys.length > 5) return { ok: false, error: 'Nothing to change.' };
    const next: Record<string, unknown> = { ...(row.context ?? {}) };
    for (const key of keys) {
        const def = patchableSetupFieldDef(row.roleKey, key);
        if (!def) {
            const excluded = exclusionReason(row.roleKey, key);
            return { ok: false, error: excluded ? `That answer is changed elsewhere: ${excluded}` : `This assistant has no set-up question called "${key}".` };
        }
        const checked = validateSetupValue(def, patch[key]);
        if (!checked.ok) return { ok: false, error: checked.error };
        next[key] = checked.value;
    }
    return { ok: true, context: next };
}

const CARD_SHAPE = `{"type":"setup_field_proposal","assistantId":<id>,"key":"<key from the list>","value":"<the new answer: an option's value, a number, or text>","summary":"<one sentence>","why":"<why, from what the user said or the figures you see>","asked":<true only if the user asked for exactly this change>}`;

/** The Business Mentor's card instructions (its <workspace> block lists each active assistant's answers). */
export function mentorSetupFieldPromptLine(): string {
    return `Change one set-up answer on an ACTIVE assistant listed under SET-UP ANSWERS. One answer per card; only a key listed there; for a choice, one of its listed values. Never for a paused, unhired or archived assistant. Name the assistant in the summary:
${CARD_SHAPE}`;
}

/** Every other structured route: its own set-up answers and the card. Null when it has none to change. */
export function assistantSetupFieldBlock(roleKey: string | null | undefined, assistantId: number, ctx: unknown): string | null {
    const lines = renderSetupFields(roleKey ?? '', (ctx as Record<string, unknown> | null) ?? null);
    if (!lines.length) return null;
    return `YOUR SET-UP ANSWERS (what the user told you when they set you up; also on your Assistant Profile):
${lines.join('\n')}
To change ONE of these when the user asks (or agrees to your suggestion), put this card in "uiElement" — nothing changes until they click "Save this":
${CARD_SHAPE.replace('<id>', String(assistantId))}
Never say an answer has been changed — the user decides on the card.`;
}
