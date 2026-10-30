// src/utils/chat-discussion-action.ts
// The Lead Generator chat's hands on its Discussions tab: change what it watches, start a scan,
// redraft a reply, mark a thread replied, or dismiss one. The discussions twin of
// chat-lead-action.ts.
//
// The model never acts. It proposes a `discussion_action_proposal`; this module checks it against
// the watch and the thread rows — this assistant's, this organisation's — and rebuilds the card
// from them. The click calls netlify/functions/discussions.ts, the same endpoint as the tab's
// buttons, so the GUI and chat share one path.
//
// A redraft card shows the CURRENT stored reply, never the model's own words — the user reads what
// is there, and the click rewrites it. Nothing on this card posts anywhere.
//
// ⚠️ Never throws.

import type { getDb } from '../../db/client';
import {
    DISCUSSION_SITES, MAX_TOPICS, normaliseSites, normaliseTopics, type DiscussionSiteKey,
} from '../config/discussion-sites';
import { discussionView, loadDiscussion, loadWatch, watchView } from './discussions';

type Db = ReturnType<typeof getDb>;

export const DISCUSSION_ACTION_PROPOSAL_TYPE = 'discussion_action_proposal';
export const DISCUSSION_ACTIONS = ['set_watch', 'scan_now', 'redraft', 'mark_replied', 'dismiss'] as const;
export type DiscussionAction = typeof DISCUSSION_ACTIONS[number];

export interface DiscussionActionRequest {
    action: DiscussionAction;
    discussionId: number | null;
    topics: string[] | null;
    sites: DiscussionSiteKey[] | null;
    enabled: boolean | null;
    instruction: string | null;
}

/** Shape check on the model's output. Pure. Null when it is not a usable proposal. */
export function discussionActionFromUiElement(uiElement: unknown): DiscussionActionRequest | null {
    if (!uiElement || typeof uiElement !== 'object') return null;
    const ui = uiElement as Record<string, unknown>;
    if (ui.type !== DISCUSSION_ACTION_PROPOSAL_TYPE) return null;
    const action = DISCUSSION_ACTIONS.find((a) => a === ui.action);
    if (!action) return null;
    const id = Number(String(ui.discussionId ?? ui.id ?? '').replace(/^#/, ''));
    const discussionId = Number.isInteger(id) && id > 0 ? id : null;
    if ((action === 'redraft' || action === 'mark_replied' || action === 'dismiss') && !discussionId) return null;
    const topics = Array.isArray(ui.topics) ? normaliseTopics(ui.topics) : null;
    const sites = Array.isArray(ui.sites) ? normaliseSites(ui.sites) : null;
    const enabled = typeof ui.enabled === 'boolean' ? ui.enabled : null;
    if (action === 'set_watch' && !topics && !sites && enabled === null) return null;
    const instruction = action === 'redraft' && typeof ui.instruction === 'string' && ui.instruction.trim()
        ? ui.instruction.trim().slice(0, 600) : null;
    return { action, discussionId, topics, sites, enabled, instruction };
}

export interface DiscussionActionCard {
    type: typeof DISCUSSION_ACTION_PROPOSAL_TYPE;
    action: DiscussionAction;
    assistantId: number;
    /** set_watch: before and after, as the user reads them. */
    current?: { topics: string[]; sites: string[]; enabled: boolean };
    proposed?: { topics: string[]; sites: DiscussionSiteKey[]; siteLabels: string[]; enabled: boolean };
    /** redraft / mark_replied / dismiss: the thread, from its row. */
    discussionId?: number;
    title?: string;
    url?: string;
    siteLabel?: string;
    draftReply?: string | null;
    instruction?: string | null;
    blocked: string | null;
    settled?: boolean;
}

/** Rebuild the card from the rows. Null when the thread is not this assistant's. Never throws. */
export async function resolveDiscussionActionProposal(
    db: Db, organisationId: number, assistantId: number, req: DiscussionActionRequest,
): Promise<DiscussionActionCard | null> {
    try {
        const base = { type: DISCUSSION_ACTION_PROPOSAL_TYPE, action: req.action, assistantId } as const;

        if (req.action === 'set_watch' || req.action === 'scan_now') {
            const w = watchView(await loadWatch(db, organisationId, assistantId));
            const current = { topics: w.topics, sites: w.sites.map((s) => DISCUSSION_SITES[s].label), enabled: w.enabled };
            if (req.action === 'scan_now') {
                const blocked = !w.topics.length ? 'There’s nothing to look for yet — add a topic first.'
                    : !w.sites.length ? 'No sites are being watched — choose at least one first.'
                    : w.scanning ? 'A scan is already running — the new threads will be on the Discussions tab in a minute or two.'
                    : null;
                return { ...base, current, blocked };
            }
            const topics = req.topics ?? w.topics;
            const sites = req.sites ?? w.sites;
            const enabled = req.enabled ?? w.enabled;
            const blocked = !topics.length ? `Give at least one topic (up to ${MAX_TOPICS}).`
                : !sites.length ? 'Choose at least one site to watch.'
                : null;
            return { ...base, current, proposed: { topics, sites, siteLabels: sites.map((s) => DISCUSSION_SITES[s].label), enabled }, blocked };
        }

        const row = req.discussionId ? await loadDiscussion(db, organisationId, assistantId, req.discussionId) : null;
        if (!row) return null;
        const d = discussionView(row);
        const thread = { discussionId: d.id, title: d.title, url: d.url, siteLabel: d.siteLabel, draftReply: d.draftReply };
        let blocked: string | null = null;
        if (req.action === 'mark_replied' && d.status === 'replied') blocked = 'It’s already marked as replied.';
        if (req.action === 'dismiss' && d.status === 'dismissed') blocked = 'It’s already dismissed.';
        return { ...base, ...thread, instruction: req.instruction, blocked };
    } catch (err) {
        console.error('[chat-discussion-action] could not resolve', err instanceof Error ? err.message : err);
        return null;
    }
}
