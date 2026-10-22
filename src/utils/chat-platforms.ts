// src/utils/chat-platforms.ts
// Which connected platforms this assistant posts to — the "Use for this assistant" switches in the
// Assistant Profile's Connections card — as the chat sees them, and a card to turn them on or off.
//
// ── Why ──────────────────────────────────────────────────────────────────────────────────────────
// Every capability is meant to be reachable from the GUI and from chat, through the same server
// action. "Stop posting to Facebook" could only be done with the switch; the chat could not even
// say which platforms were on.
//
// ── What a switch is ─────────────────────────────────────────────────────────────────────────────
// integrations.js `_intToggleUseForAssistant` writes three things through update-assistant-context:
//   onboarding_context.linked_integrations    — the ticked connection ids (negative = workspace_integrations)
//   configuration.appliedDefaults.platforms   — the same ids
//   onboarding_context.primary_platforms      — short codes (fb/ig/…) for the ticked LIVE connections
// A switch shows ON when its connection id is in either id list. Drafting reads all three through
// assistant-platform-selection.ts, where an EMPTY selection means "draft for every connected platform".
// So turning the last switch off does not stop drafting — it widens it. The card refuses that and
// points at pausing instead.
//
// ── How ──────────────────────────────────────────────────────────────────────────────────────────
// Same contract as the other confirm cards. The model proposes `platforms_proposal` {turnOn, turnOff}
// by platform name; this module checks the names against the user's live connections and builds the
// exact lists the switch would write. The click (chat-session.js) re-reads the context, refuses if the
// switches moved since the card was drawn (`before`), and saves through update-assistant-context.ts
// exactly as the switch does. Nothing here writes.
//
// The connection list mirrors integrations.ts GET (the rows the Connections card draws): the user's own
// system_connections in this organisation, live first, one per service; Threads/YouTube from
// workspace_integrations under a negative id unless a system_connections row already exists; filtered
// by the role's connector policy. It is not shared code because several source-scan tests pin that
// query's shape where it is — keep the two in step.
//
// ⚠️ Never throws.

import { and, desc, eq, inArray } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, systemConnections, workspaceIntegrations } from '../../db/schema';
import { normalizePlatform, type SocialPlatform } from '../config/platform-formats';
import { isServiceAllowedForAssistant } from './connection-map';
import { resolveAssistantRole } from './assistant-role';
import { resolveAssistantEnabledPlatforms } from './assistant-platform-selection';
import { platformName } from './team-activity';

type Db = ReturnType<typeof getDb>;

export const PLATFORMS_PROPOSAL_TYPE = 'platforms_proposal';

/** integrations.js PLATFORM_KEY_MAP, keyed by the normalised platform. */
const SHORT_CODE: Record<string, string> = { facebook: 'fb', instagram: 'ig', linkedin: 'li', x: 'x', tiktok: 'tt', youtube: 'yt', threads: 'th', pinterest: 'pin' };
/** The social services the Connections card can show a switch for. */
const SOCIAL_SERVICES = ['facebook', 'instagram', 'linkedin', 'x', 'threads', 'tiktok', 'youtube'];
/** integrations.ts WORKSPACE_BACKED, minus Canva (a design source, never a switch). */
const WORKSPACE_SOCIAL = ['threads', 'youtube'];

export interface LiveConnection { id: number; platform: SocialPlatform }

/** Every id the two selection lists name — what the switches show as ON. Pure. */
export function selectedIds(ctx: unknown, configuration: unknown): number[] {
    const c = (ctx && typeof ctx === 'object' ? ctx : {}) as Record<string, unknown>;
    const applied = (configuration as { appliedDefaults?: { platforms?: unknown } } | null)?.appliedDefaults?.platforms;
    const ids = new Set<number>();
    for (const list of [c.linked_integrations, applied]) {
        if (!Array.isArray(list)) continue;
        for (const raw of list) { const n = Number(raw); if (Number.isInteger(n) && n !== 0) ids.add(n); }
    }
    return [...ids].sort((a, b) => a - b);
}

/**
 * The live social connections this user's Connections card shows a switch for, or null when the role
 * shows none (no social connector is allowed for it).
 */
export async function loadLiveConnections(db: Db, organisationId: number, userId: number, aiAssistantId: number): Promise<LiveConnection[] | null> {
    const role = await resolveAssistantRole(db, organisationId, aiAssistantId);
    if (!SOCIAL_SERVICES.some((s) => isServiceAllowedForAssistant(s, role))) return null;
    const [sys, ws] = await Promise.all([
        db.select({ id: systemConnections.id, serviceName: systemConnections.serviceName, status: systemConnections.status })
            .from(systemConnections)
            .where(and(eq(systemConnections.organisationId, organisationId), eq(systemConnections.userId, userId)))
            .orderBy(desc(systemConnections.isActive), desc(systemConnections.updatedAt)),
        db.select({ id: workspaceIntegrations.id, provider: workspaceIntegrations.provider, status: workspaceIntegrations.status })
            .from(workspaceIntegrations)
            .where(and(eq(workspaceIntegrations.organisationId, organisationId), inArray(workspaceIntegrations.provider, WORKSPACE_SOCIAL))),
    ]);
    const merged: Array<{ id: number; serviceName: string; status: string | null }> = [];
    for (const r of sys) if (r.serviceName && !merged.some((m) => m.serviceName === r.serviceName)) merged.push({ id: r.id, serviceName: r.serviceName, status: r.status });
    for (const r of ws) {
        const existing = merged.find((m) => m.serviceName === r.provider);
        if (existing) existing.status = r.status; else merged.push({ id: -r.id, serviceName: r.provider, status: r.status });
    }
    const out: LiveConnection[] = [];
    for (const m of merged) {
        const platform = normalizePlatform(m.serviceName);
        if (m.status === 'active' && platform && isServiceAllowedForAssistant(m.serviceName, role) && !out.some((o) => o.platform === platform)) out.push({ id: m.id, platform });
    }
    return out;
}

async function readAssistant(db: Db, organisationId: number, aiAssistantId: number) {
    const [row] = await db.select({ ctx: aiAssistants.onboardingContext, config: aiAssistants.configuration }).from(aiAssistants)
        .where(and(eq(aiAssistants.id, aiAssistantId), eq(aiAssistants.organisationId, organisationId))).limit(1);
    return row ?? null;
}

const names = (ps: string[]) => ps.map(platformName).join(', ');

/** The block for this turn's prompt. Null for a role with no switches, or when the read fails. */
export async function buildPlatformsBlock(db: Db, organisationId: number, userId: number, aiAssistantId: number): Promise<string | null> {
    try {
        const live = await loadLiveConnections(db, organisationId, userId, aiAssistantId);
        if (!live) return null;
        const row = await readAssistant(db, organisationId, aiAssistantId);
        if (!row) return null;
        const on = new Set(selectedIds(row.ctx, row.config));
        const effective = await resolveAssistantEnabledPlatforms(db, { organisationId, onboardingContext: row.ctx, configuration: row.config });
        const lines = live.length
            ? live.map((c) => `- ${platformName(c.platform)}: ${on.has(c.id) ? 'ON' : 'off'}`).join('\n')
            : '- none — no social account is connected for this user yet';
        const drafting = !effective
            ? 'No switch is on, so this assistant drafts for EVERY connected platform.'
            : `This assistant drafts for: ${names([...effective])}.`;
        return `WHERE YOU POST — the "Use for this assistant" switches in Assistant Profile ▸ Connections, for each social account connected right now:
${lines}
${drafting} A platform not listed above is not connected; connecting one is done in Assistant Profile ▸ Connections, never from here.
CHANGING THEM — when the user asks to start or stop posting to a connected platform, put this in "uiElement" instead of anything else:
{ "type": "platforms_proposal", "turnOn": ["instagram", …], "turnOff": ["facebook", …] }
Use the platform names above, lower case. Turning off the last switch that is on does NOT stop posting — with none on, the assistant drafts for every platform — so if the user wants to stop posting altogether, offer to pause the assistant instead. Posts already drafted or booked for a platform keep their place; this changes what is drafted from now on. You never change a switch yourself: the user confirms on the card, and only that click saves it. So never say a switch HAS changed — say the card is there to confirm.`;
    } catch (err) {
        console.error('[chat-platforms] could not build the block (non-fatal)', err);
        return null;
    }
}

// ── Propose ──────────────────────────────────────────────────────────────────────────────────────

export interface PlatformsRequest { turnOn: string[]; turnOff: string[]; unknown: string[] }

/** Shape check. Pure. Null when it is not a platforms proposal or names nothing. */
export function platformsProposalFromUiElement(uiElement: unknown): PlatformsRequest | null {
    if (!uiElement || typeof uiElement !== 'object') return null;
    const ui = uiElement as Record<string, unknown>;
    if (ui.type !== PLATFORMS_PROPOSAL_TYPE) return null;
    const req: PlatformsRequest = { turnOn: [], turnOff: [], unknown: [] };
    const read = (list: unknown, into: string[]) => {
        if (!Array.isArray(list)) return;
        for (const raw of list) {
            const p = normalizePlatform(String(raw).trim().toLowerCase());
            if (!p) req.unknown.push(String(raw));
            else if (!into.includes(p)) into.push(p);
        }
    };
    read(ui.turnOn, req.turnOn);
    read(ui.turnOff, req.turnOff);
    if (!req.turnOn.length && !req.turnOff.length && !req.unknown.length) return null;
    return req;
}

export interface PlatformsCard {
    type: typeof PLATFORMS_PROPOSAL_TYPE;
    assistantId: number;
    /** Platform names switched on now, and after the click. */
    nowOn: string[];
    afterOn: string[];
    changes: Array<{ platform: string; on: boolean }>;
    /** The selected ids the card was drawn against — the click refuses if they have moved. */
    before: number[];
    /** What the click writes: linked_integrations = appliedDefaults.platforms, and primary_platforms. */
    linked: number[];
    codes: string[];
    blocked: string | null;
    settled?: boolean;
}

/** Build the card from the live connections and the stored selection. Pure — tested without a database. */
export function buildPlatformsCard(aiAssistantId: number, live: LiveConnection[], ctx: unknown, config: unknown, req: PlatformsRequest): PlatformsCard {
    const before = selectedIds(ctx, config);
    const ids = new Set(before);
    const byPlatform = new Map(live.map((c) => [c.platform as string, c]));
    const notConnected: string[] = [];
    const changes: PlatformsCard['changes'] = [];
    for (const [list, on] of [[req.turnOn, true], [req.turnOff, false]] as const) {
        for (const p of list) {
            const c = byPlatform.get(p);
            if (!c) { notConnected.push(p); continue; }
            if (ids.has(c.id) === on) continue;
            if (on) ids.add(c.id); else ids.delete(c.id);
            changes.push({ platform: platformName(p), on });
        }
    }
    const onNames = (set: Set<number>) => live.filter((c) => set.has(c.id)).map((c) => platformName(c.platform));
    const linked = [...ids].sort((a, b) => a - b);
    const card: PlatformsCard = {
        type: PLATFORMS_PROPOSAL_TYPE, assistantId: aiAssistantId,
        nowOn: onNames(new Set(before)), afterOn: onNames(ids), changes, before, linked,
        // Like the switch: codes for the ticked LIVE connections only.
        codes: live.filter((c) => ids.has(c.id)).map((c) => SHORT_CODE[c.platform] ?? c.platform),
        blocked: null,
    };
    if (req.unknown.length) card.blocked = `“${req.unknown.join('”, “')}” isn’t a platform this assistant can post to.`;
    else if (notConnected.length) card.blocked = `${names(notConnected)} ${notConnected.length === 1 ? 'isn’t' : 'aren’t'} connected — connect ${notConnected.length === 1 ? 'it' : 'them'} in Assistant Profile ▸ Connections first.`;
    else if (!changes.length) card.blocked = 'The switches already say exactly that.';
    else if (!card.afterOn.length) card.blocked = 'With every switch off, this assistant would draft for every platform, not none. To stop posting, pause the assistant instead.';
    return card;
}

/** Check a proposal against the live connections and the stored switches. Null when a read fails. */
export async function resolvePlatformsProposal(
    db: Db, organisationId: number, userId: number, aiAssistantId: number, req: PlatformsRequest,
): Promise<PlatformsCard | null> {
    try {
        const [live, row] = await Promise.all([loadLiveConnections(db, organisationId, userId, aiAssistantId), readAssistant(db, organisationId, aiAssistantId)]);
        if (!row) return null;
        if (!live) return { ...buildPlatformsCard(aiAssistantId, [], row.ctx, row.config, req), blocked: 'This assistant doesn’t post to social platforms.' };
        return buildPlatformsCard(aiAssistantId, live, row.ctx, row.config, req);
    } catch (err) {
        console.error('[chat-platforms] could not resolve the proposal (non-fatal)', err);
        return null;
    }
}

/** A stored card closes once the switches already hold what it would write. */
export async function refreshPlatformsCards<M extends { uiElement: unknown }>(
    db: Db, organisationId: number, aiAssistantId: number, messages: M[],
): Promise<M[]> {
    if (!messages.some((m) => (m.uiElement as { type?: unknown } | null)?.type === PLATFORMS_PROPOSAL_TYPE)) return messages;
    let now: number[];
    try {
        const row = await readAssistant(db, organisationId, aiAssistantId);
        if (!row) return messages;
        now = selectedIds(row.ctx, row.config);
    } catch (err) {
        console.error('[chat-platforms] could not refresh stored cards (non-fatal)', err);
        return messages;
    }
    return messages.map((m) => {
        const ui = m.uiElement as Record<string, unknown> | null;
        if (!ui || ui.type !== PLATFORMS_PROPOSAL_TYPE || ui.settled || ui.blocked) return m;
        const linked = Array.isArray(ui.linked) ? (ui.linked as number[]) : [];
        if (linked.join() === now.join()) return { ...m, uiElement: { ...ui, settled: true, blocked: 'Already done — the switches say this now.' } };
        const before = Array.isArray(ui.before) ? (ui.before as number[]) : [];
        if (before.join() !== now.join()) return { ...m, uiElement: { ...ui, settled: true, blocked: 'The switches have changed since — ask again if you still want this.' } };
        return m;
    });
}
