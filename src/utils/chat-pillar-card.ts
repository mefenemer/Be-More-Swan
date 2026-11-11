// src/utils/chat-pillar-card.ts
// The Social Media chat's content pillar card (docs/pillar-records-plan.md, phase 2). One pillar per card:
// add one, rename / re-describe / switch one on or off, archive one, or bring an archived one back. The
// model names the pillar by its id from YOUR CONTENT PILLARS; the server rebuilds the card from the rows
// (resolvePillarProposal) so the browser never shows a change the rules would refuse, and the user's click
// applies it through netlify/functions/content-pillars.ts, the same path as the profile's pillar list.
// Chat proposes; it never changes a pillar itself.
//
// The Social chat no longer changes pillars through the set-up answer card (it used to retype the whole
// list). The Business Mentor still does, and the server reconciles that text to the records
// (syncPillarsFromNames), keeping each matching pillar's row and description.

import type { getDb } from '../../db/client';
import {
    listPillars, listRestorablePillars, validatePillarFields,
    MAX_ACTIVE_PILLARS, MAX_PILLAR_DESCRIPTION, MAX_PILLAR_NAME, type Pillar,
} from './content-pillars-store';

type Db = ReturnType<typeof getDb>;

export const PILLAR_CARD_TYPE = 'pillar_proposal';
export type PillarCardAction = 'add' | 'update' | 'archive' | 'restore';
const ACTIONS: readonly PillarCardAction[] = ['add', 'update', 'archive', 'restore'];

export interface PillarCard {
    type: typeof PILLAR_CARD_TYPE;
    assistantId: number;
    action: PillarCardAction;
    /** The pillar changed (update / archive / restore). Null for add. */
    pillarId: number | null;
    summary: string;
    /** What it is now (update / archive / restore), shown as "Now". */
    before: { name: string; description: string | null; isActive: boolean } | null;
    /** Only the fields this card changes. */
    change: { name?: string; description?: string | null; isActive?: boolean };
    /** A restore or add that lands switched off because five are already on. */
    landsOff?: boolean;
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Pure: the prompt block — the pillars with their ids, the archived ones, and the card. */
export function pillarPromptBlock(assistantId: number, live: Pillar[] | null, archived: Pillar[]): string | null {
    if (live === null) return null; // the SQL is not applied yet: no card to offer
    const on = live.filter((p) => p.isActive).length;
    const line = (p: Pillar) => `  - #${p.id} "${p.name}"${p.isActive ? '' : ' (switched off)'}${p.description ? ` — ${p.description}` : ''}`;
    return `YOUR CONTENT PILLARS (the themes your posts rotate between; on "What I post about" in your settings, one row each). ${on} of ${MAX_ACTIVE_PILLARS} switched on:
${live.length ? live.map(line).join('\n') : '  (none yet)'}
${archived.length ? `Archived (can be brought back with their description and post history):\n${archived.map((p) => `  - #${p.id} "${p.name}"`).join('\n')}` : ''}
To change ONE pillar when the user asks (or agrees to your suggestion), put this card in "uiElement". Nothing changes until they click it:
{"type":"${PILLAR_CARD_TYPE}","action":"add"|"update"|"archive"|"restore","pillarId":<the # number, not for add>,"name":"<add, or a new name for update; a short theme, at most ${MAX_PILLAR_NAME} characters>","description":"<optional: what goes under this pillar, at most ${MAX_PILLAR_DESCRIPTION} characters; \\"\\" clears it>","isActive":true|false,"summary":"<one sentence>"}
For update send only what changes. "archive" takes it out of drafting (posts keep it); "restore" brings back an archived one. At most ${MAX_ACTIVE_PILLARS} can be switched on: to add one when ${MAX_ACTIVE_PILLARS} are on, suggest switching one off or archiving it first. One pillar per card; for several, do one and say you will do the next after. Never say a pillar has been changed. After a change, the upcoming drafts were written before it: you may offer redraft_upcoming_proposal.`;
}

/** Pure: the request in a model's uiElement, or null when it is not a pillar card. */
export function pillarRequestFromUiElement(ui: unknown): Record<string, unknown> | null {
    const u = ui as Record<string, unknown> | null;
    return u && u.type === PILLAR_CARD_TYPE ? u : null;
}

/**
 * Pure: the card from the request and the rows, or why not. `live` = non-archived rows, `archived` =
 * restorable rows (one per name).
 */
export function buildPillarCard(assistantId: number, req: Record<string, unknown>, live: Pillar[], archived: Pillar[])
    : PillarCard | { error: string } {
    const action = String(req.action ?? '') as PillarCardAction;
    if (!ACTIONS.includes(action)) return { error: 'It didn\'t say whether to add, change, archive or bring back a pillar.' };
    const summary = str(req.summary, 300);
    const onCount = live.filter((p) => p.isActive).length;
    const full = onCount >= MAX_ACTIVE_PILLARS;
    const pillarId = Number(req.pillarId);
    const fields = validatePillarFields({
        name: req.name === undefined || req.name === null || req.name === '' ? undefined : req.name,
        description: req.description === undefined ? undefined : req.description,
    });
    if (!fields.ok) return { error: fields.error };

    if (action === 'add') {
        if (!fields.name) return { error: 'A new pillar needs a name.' };
        const same = live.find((p) => p.name.toLowerCase() === fields.name!.toLowerCase());
        if (same) return { error: `There is already a pillar called "${same.name}".` };
        // A name that was archived comes back with its history rather than as a new, empty pillar.
        const old = archived.find((p) => p.name.toLowerCase() === fields.name!.toLowerCase());
        if (old) {
            return {
                type: PILLAR_CARD_TYPE, assistantId, action: 'restore', pillarId: old.id,
                summary: summary || `Bring back "${old.name}"`,
                before: { name: old.name, description: old.description, isActive: false }, change: {}, landsOff: full,
            };
        }
        const wantOn = req.isActive !== false;
        if (wantOn && full) return { error: `${MAX_ACTIVE_PILLARS} pillars are already switched on. Switch one off or archive it first.` };
        return {
            type: PILLAR_CARD_TYPE, assistantId, action, pillarId: null,
            summary: summary || `Add the pillar "${fields.name}"`, before: null,
            change: { name: fields.name, ...(fields.description ? { description: fields.description } : {}), ...(wantOn ? {} : { isActive: false }) },
        };
    }

    if (action === 'restore') {
        const old = archived.find((p) => p.id === pillarId);
        if (!old) return { error: 'That archived pillar isn\'t in the list.' };
        return {
            type: PILLAR_CARD_TYPE, assistantId, action, pillarId: old.id, summary: summary || `Bring back "${old.name}"`,
            before: { name: old.name, description: old.description, isActive: false }, change: {}, landsOff: full,
        };
    }

    const row = live.find((p) => p.id === pillarId);
    if (!row) return { error: 'That pillar isn\'t in the list (it may have been archived).' };
    const before = { name: row.name, description: row.description, isActive: row.isActive };

    if (action === 'archive') {
        return { type: PILLAR_CARD_TYPE, assistantId, action, pillarId: row.id, summary: summary || `Archive "${row.name}"`, before, change: {} };
    }

    // update: only what actually changes
    const change: PillarCard['change'] = {};
    if (fields.name && fields.name !== row.name) {
        if (live.some((p) => p.id !== row.id && p.name.toLowerCase() === fields.name!.toLowerCase())) {
            return { error: `There is already a pillar called "${fields.name}".` };
        }
        change.name = fields.name;
    }
    if (fields.description !== undefined && (fields.description ?? null) !== (row.description ?? null)) change.description = fields.description ?? null;
    if (typeof req.isActive === 'boolean' && req.isActive !== row.isActive) {
        if (req.isActive && full) return { error: `${MAX_ACTIVE_PILLARS} pillars are already switched on. Switch another one off first.` };
        change.isActive = req.isActive;
    }
    if (!Object.keys(change).length) return { error: `"${row.name}" already reads that way, so nothing would change.` };
    return { type: PILLAR_CARD_TYPE, assistantId, action, pillarId: row.id, summary: summary || `Change "${row.name}"`, before, change };
}

/** The chat's prompt block for a Social Media assistant. Never throws (null on any failure). */
export async function buildPillarChatBlock(db: Db, orgId: number, assistantId: number): Promise<string | null> {
    try {
        const live = await listPillars(db, orgId, assistantId);
        if (live === null) return null;
        return pillarPromptBlock(assistantId, live, await listRestorablePillars(db, orgId, assistantId));
    } catch (err) {
        console.warn('[chat-pillar-card] block failed:', (err as Error)?.message);
        return null;
    }
}

/** Rebuilds the model's card from the rows, or says why not. */
export async function resolvePillarProposal(db: Db, orgId: number, assistantId: number, req: Record<string, unknown>)
    : Promise<PillarCard | { error: string }> {
    const live = await listPillars(db, orgId, assistantId);
    if (live === null) return { error: 'Pillars are being upgraded, so this can\'t be changed from the chat just now.' };
    return buildPillarCard(assistantId, req, live, await listRestorablePillars(db, orgId, assistantId));
}
