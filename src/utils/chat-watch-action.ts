// src/utils/chat-watch-action.ts
// The Lead Generator chat's hands on its Watch list (buying triggers Phase 2): add a company, stop or
// restart watching one, and switch the Watch list on or off. The Watch list twin of
// chat-discussion-action.ts.
//
// The model never acts. It proposes a `watch_action_proposal`; this module checks it against this
// assistant's rows (or asks Companies House which companies match a name) and rebuilds the card from
// what it found. The click calls netlify/functions/lead-watch.ts, the same endpoint as the tab's
// buttons (chat-session.js onWatchAction), so the GUI and chat share one path.
//
// ⚠️ Never throws.

import { sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { normaliseCompanyNumber } from '../lib/triggers/ch-watch';
import { getCompanyProfile } from '../lib/companies-house';
import { buildWatchChatBlock, isWatchEnabled, searchForWatch } from './lead-watch-list';

type Db = ReturnType<typeof getDb>;

export const WATCH_ACTION_PROPOSAL_TYPE = 'watch_action_proposal';
export const WATCH_CARD_ACTIONS = ['add', 'remove', 'resume', 'set_enabled'] as const;
export type WatchCardAction = typeof WATCH_CARD_ACTIONS[number];

export interface WatchActionRequest {
    action: WatchCardAction;
    watchId: number | null;
    number: string | null;
    companyName: string | null;
    enabled: boolean | null;
}

/** Shape check on the model's output. Pure. Null when it is not a usable proposal. */
export function watchActionFromUiElement(uiElement: unknown): WatchActionRequest | null {
    if (!uiElement || typeof uiElement !== 'object') return null;
    const ui = uiElement as Record<string, unknown>;
    if (ui.type !== WATCH_ACTION_PROPOSAL_TYPE) return null;
    const action = WATCH_CARD_ACTIONS.find((a) => a === ui.action);
    if (!action) return null;
    const id = Number(String(ui.watchId ?? '').replace(/^#/, ''));
    const watchId = Number.isInteger(id) && id > 0 ? id : null;
    const number = normaliseCompanyNumber(ui.number);
    const companyName = typeof ui.companyName === 'string' && ui.companyName.trim() ? ui.companyName.trim().slice(0, 120) : null;
    const enabled = typeof ui.enabled === 'boolean' ? ui.enabled : null;
    if ((action === 'remove' || action === 'resume') && !watchId) return null;
    if (action === 'add' && !number && !companyName) return null;
    if (action === 'set_enabled' && enabled === null) return null;
    return { action, watchId, number, companyName, enabled };
}

export interface WatchActionCard {
    type: typeof WATCH_ACTION_PROPOSAL_TYPE;
    action: WatchCardAction;
    assistantId: number;
    watchId?: number;
    companyName?: string | null;
    number?: string | null;
    kind?: string;
    /** add by name: the register entries that match, each with its own Watch button. */
    candidates?: Array<{ number: string; name: string; status: string; postcode: string | null }>;
    enabled?: boolean;
    blocked: string | null;
    settled?: boolean;
}

/** Rebuild the card from the rows. Null when the row is not this assistant's. Never throws. */
export async function resolveWatchActionProposal(db: Db, organisationId: number, assistantId: number, req: WatchActionRequest): Promise<WatchActionCard | null> {
    try {
        const base = { type: WATCH_ACTION_PROPOSAL_TYPE, action: req.action, assistantId } as const;
        if (req.action === 'set_enabled') {
            const now = await isWatchEnabled(db, assistantId);
            return { ...base, enabled: req.enabled === true, blocked: now === req.enabled ? `The Watch list is already ${now ? 'on' : 'off'}.` : null };
        }
        if (req.action === 'add') {
            if (req.number) {
                const prof = await getCompanyProfile(req.number);
                if (!prof.ok) return { ...base, number: req.number, companyName: req.companyName, blocked: 'Companies House did not answer just now. Ask me again in a minute.' };
                if (!prof.profile) return { ...base, number: req.number, blocked: `Companies House has no company ${req.number}.` };
                return { ...base, number: prof.profile.number, companyName: prof.profile.name, blocked: null };
            }
            const found = await searchForWatch(req.companyName ?? '');
            if (!found.ok) return { ...base, companyName: req.companyName, blocked: found.error };
            const candidates = found.items.slice(0, 5);
            return { ...base, companyName: req.companyName, candidates, blocked: candidates.length ? null : `Companies House has no company called “${req.companyName}”. Check the name, or give me its company number.` };
        }
        const [row] = await db.execute(sql`
            SELECT id, watch_kind, company_name, ch_number, paused_reason FROM lead_watch
             WHERE id = ${req.watchId} AND organisation_id = ${organisationId} AND ai_assistant_id = ${assistantId}`) as Array<{ id: number; watch_kind: string; company_name: string | null; ch_number: string; paused_reason: string | null }>;
        if (!row) return null;
        const card = { ...base, watchId: Number(row.id), companyName: row.company_name, number: row.ch_number, kind: row.watch_kind };
        if (req.action === 'resume') return { ...card, blocked: row.paused_reason === 'removed_by_user' ? null : 'It is already being watched.' };
        return { ...card, blocked: row.paused_reason === 'removed_by_user' ? 'You have already stopped watching it.' : null };
    } catch (err) {
        console.error('[chat-watch-action] could not resolve', err instanceof Error ? err.message : err);
        return null;
    }
}

/** The Lead Generator prompt block: what the Watch list holds, plus the card it may propose. */
export async function buildWatchActionsChatBlock(db: Db, organisationId: number, assistantId: number): Promise<string | null> {
    const view = await buildWatchChatBlock(db, organisationId, assistantId);
    if (!view) return null;
    return `${view}
The Watch list checks companies on Companies House (UK) for free every few days: customers (leads marked won), leads matched to Companies House, and companies the user adds by hand. It reports a new director, a director leaving, a new owner or controller, a move of registered office, a new charge (borrowing), and a company going into liquidation, administration or being dissolved (that also stops the lead's follow-ups). The wording of each item is fixed and comes from the register; nothing is sent to anyone. The first check of a company only records where it stands, so nothing from before it was watched is reported. When the user asks "what's new with my customers / leads?", answer from the news above and suggest the Watch list tab.
To change the Watch list, emit a watch_action_proposal uiElement — the user confirms on the card, and only their click changes anything:
{ "type": "watch_action_proposal", "action": "add" | "remove" | "resume" | "set_enabled",
  "number": "<Companies House number, if the user gave it>",      // add
  "companyName": "<the company's name>",                          // add (when no number: the card lists the matches to pick from)
  "watchId": <the watch id above>,                                // remove / resume
  "enabled": true | false }                                       // set_enabled
Only UK companies on Companies House can be watched. Never say a company has been added, removed or switched on: the card does nothing until the user presses its button — say it is on the card for them to confirm. ONE card per message.`;
}
