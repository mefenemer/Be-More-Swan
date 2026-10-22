// src/utils/chat-assistant-settings.ts
// What every assistant's chat knows about ITSELF — its status and its own settings — and
// its hands on those settings: pause or resume it, how far ahead it drafts, how urgently it chases
// approvals, and whether it suggests content with AI pictures on its own.
//
// ── Why ──────────────────────────────────────────────────────────────────────────────────────────
// Every capability is meant to be reachable from the GUI and from chat, through the same server
// action. The chat read the assistant's setup answers (onboardingContext) and nothing else on its row:
// "are you paused?", "how far ahead are you drafting?" and "how are my goals going?" got a guess or
// directions to the Assistant Profile, and "pause for a week" or "draft two weeks ahead" could only be
// done there. The parity audit of 2026-10-22 listed these as the largest gap.
//
// ── How ──────────────────────────────────────────────────────────────────────────────────────────
// Read: buildAssistantSettingsSnapshot() is read per turn for EVERY role, like the content snapshots,
// so a change made on the page a moment ago is in the next answer.
//
// Write: the same contract as chat-blog-action.ts. The model never acts. It proposes an
// `assistant_settings_proposal`; this module checks it against the row — the setting must be one this
// role shows on its page (SETTINGS_BY_ROLE mirrors assistant-dashboard-registry.js, pinned by
// tests/chat-assistant-settings.test.ts), and the change must be a change — and rebuilds the card from
// what is true. The click (chat-session.js) calls the SAME endpoints the page does: manage-assistant
// (pause), kickoff-assistant (resume — the page resumes through Kick Off too, never a silent direct
// resume), set-draft-horizon, set-review-notif-prefs and set-autonomous-media. Their gates apply
// unchanged: owner/admin to pause, the readiness checklist to resume, 1–30 days. Nothing here writes.
//
// Archiving is deliberately not offered: it ends the assistant and starts a deletion clock, and stays
// a page action behind its own warning.
//
// ⚠️ Never throws.

import { and, desc, eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants } from '../../db/schema';
import { MAX_HORIZON_DAYS, MIN_HORIZON_DAYS } from '../config/posting-cadence';

type Db = ReturnType<typeof getDb>;

export const ASSISTANT_SETTINGS_PROPOSAL_TYPE = 'assistant_settings_proposal';
export const ASSISTANT_SETTINGS = ['pause', 'resume', 'draft_horizon', 'review_alerts', 'content_suggestions'] as const;
export type AssistantSetting = typeof ASSISTANT_SETTINGS[number];

/**
 * Which settings each role shows on its page, beyond pause/resume (every role has the "Assistant
 * lifecycle" buttons). Mirrors the registry's modules:
 *   draft_horizon        — "Generate posts ahead" in the Posting Schedule card (hasPostingSchedule and
 *                          not hasScheduleCard:false — the Email Marketing role's card is off).
 *   review_alerts        — Notifications ▸ "Review alerts" (hasReviewCadence).
 *   content_suggestions  — Profile ▸ When and how I post ▸ "Autonomous Content Suggestions"
 *                          (hasContentAutomation).
 */
export const SETTINGS_BY_ROLE: Readonly<Record<string, readonly AssistantSetting[]>> = {
    social_media_manager: ['draft_horizon', 'review_alerts', 'content_suggestions'],
    blog_writer: ['draft_horizon'],
    newsletter_editor: ['review_alerts'],
};

export function settingsForRole(roleKey: string | null | undefined): AssistantSetting[] {
    return ['pause', 'resume', ...(SETTINGS_BY_ROLE[roleKey ?? ''] ?? [])];
}

export const REVIEW_ALERT_VALUES = ['immediate', 'red_urgency_only', 'daily_digest'] as const;
type ReviewAlert = typeof REVIEW_ALERT_VALUES[number];
/** The radio labels on Notifications ▸ Review alerts (assistant-detail.html). */
const REVIEW_ALERT_LABEL: Record<ReviewAlert, string> = {
    immediate: 'Immediate',
    red_urgency_only: 'Urgent only',
    daily_digest: 'Daily digest',
};

/** Same ceiling as set-autonomous-media.ts. */
const MAX_MEDIA_CAP = 100000;

/** The status pill's states, in the words the page uses. */
const STATUS_WORDS: Record<string, string> = {
    provisioning: 'still being set up',
    ready_for_work: 'ready, but not started yet — it starts when the user kicks it off',
    working: 'working',
    paused: 'paused by the user — it does nothing until it is resumed',
    system_paused: 'stopped by the system because something needs fixing (usually a connection) — it cannot be resumed until that is fixed',
    archived: 'archived',
};


interface SettingsRow {
    id: number;
    name: string;
    lifecycleStatus: string;
    draftHorizonDays: number;
    reviewNotifPreference: string;
    autonomousMediaEnabled: boolean;
    autonomousMediaMonthlyCap: number;
}

async function readRow(db: Db, organisationId: number, aiAssistantId: number): Promise<SettingsRow | null> {
    const [row] = await db.select({
        id: aiAssistants.id,
        name: aiAssistants.name,
        lifecycleStatus: aiAssistants.lifecycleStatus,
        draftHorizonDays: aiAssistants.draftHorizonDays,
        reviewNotifPreference: aiAssistants.reviewNotifPreference,
        autonomousMediaEnabled: aiAssistants.autonomousMediaEnabled,
        autonomousMediaMonthlyCap: aiAssistants.autonomousMediaMonthlyCap,
    })
        .from(aiAssistants)
        .where(and(eq(aiAssistants.id, aiAssistantId), eq(aiAssistants.organisationId, organisationId)))
        .limit(1);
    return row ?? null;
}

const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
const reviewLabel = (v: string) => REVIEW_ALERT_LABEL[v as ReviewAlert] ?? v;
const suggestionsWords = (on: boolean, cap: number) => on ? `on, up to ${cap} AI pictures or videos a month` : 'off';

// ── Read ─────────────────────────────────────────────────────────────────────────────────────────

/** The block for this turn's prompt. Never throws: a failed read says so rather than inviting a guess. */
export async function buildAssistantSettingsSnapshot(
    db: Db, organisationId: number, aiAssistantId: number, roleKey: string | null | undefined,
): Promise<string> {
    try {
        const row = await readRow(db, organisationId, aiAssistantId);
        if (!row) return '';
        const available = settingsForRole(roleKey);
        const lines = [`- Status: ${STATUS_WORDS[row.lifecycleStatus] ?? row.lifecycleStatus}.`];
        if (available.includes('draft_horizon')) {
            lines.push(`- "Generate posts ahead" (Assistant Profile ▸ When and how I ${roleKey === 'blog_writer' ? 'work' : 'post'}): ${days(row.draftHorizonDays)} — you keep drafts ready this far ahead (${MIN_HORIZON_DAYS}–${MAX_HORIZON_DAYS} days).`);
        }
        if (available.includes('review_alerts')) {
            lines.push(`- "Review alerts" (Assistant Profile ▸ Notifications): ${reviewLabel(row.reviewNotifPreference)} — how urgently the user is chased when drafts wait for approval. The choices are Immediate, Urgent only and Daily digest.`);
        }
        if (available.includes('content_suggestions')) {
            lines.push(`- "Autonomous Content Suggestions" (Assistant Profile ▸ When and how I post):${suggestionsWords(row.autonomousMediaEnabled, row.autonomousMediaMonthlyCap)} — you draft posts with AI pictures on your own to fill empty slots. It stops when the plan's monthly tasks run out; nothing is ever charged extra.`);
        }

        return [
            `YOUR OWN SETTINGS RIGHT NOW (read this turn — the same values the user sees on your page; never guess a value that is not listed):`,
            ...lines,
        ].join('\n');
    } catch (err) {
        console.error('[chat-assistant-settings] snapshot read failed (non-fatal)', err);
        return 'YOUR OWN SETTINGS: could not be read this turn — say so if asked; never guess your status or a setting.';
    }
}

/** The prompt section that lets a structured route propose a change. Only the settings this role has. */
export function assistantSettingsPromptBlock(roleKey: string | null | undefined): string {
    const available = settingsForRole(roleKey);
    const shapes = [
        '{ "type": "assistant_settings_proposal", "setting": "pause" }',
        '{ "type": "assistant_settings_proposal", "setting": "resume" }',
        available.includes('draft_horizon') ? `{ "type": "assistant_settings_proposal", "setting": "draft_horizon", "days": <${MIN_HORIZON_DAYS}–${MAX_HORIZON_DAYS}> }` : '',
        available.includes('review_alerts') ? '{ "type": "assistant_settings_proposal", "setting": "review_alerts", "value": "immediate" | "red_urgency_only" | "daily_digest" }' : '',
        available.includes('content_suggestions') ? '{ "type": "assistant_settings_proposal", "setting": "content_suggestions", "enabled": true | false, "monthlyCap": <number, or omit to keep it> }' : '',
    ].filter(Boolean);
    return `CHANGING YOUR OWN SETTINGS — when the user asks you to change one of the settings listed under YOUR OWN SETTINGS, put this in "uiElement" instead of anything else (one change per reply):
${shapes.join('\n')}
"pause" stops everything you do until they resume you. "resume" starts you again (and starts you for the first time when you are ready but not started); it goes through the same readiness checks as Kick Off, so it can be refused. You never change a setting yourself: the user confirms on the card, and only that click changes anything. So never say a setting HAS changed — say the card is there to confirm. Only propose a setting that is listed above. ${available.includes('draft_horizon') ? 'Your goals, your Do’s and don’ts and your posting schedule have' : 'Your goals and your Do’s and don’ts have'} cards of their own (below). Anything else on your page (your connections, archiving you) is changed on your page: name where, using the names above.`;
}

// ── Propose ──────────────────────────────────────────────────────────────────────────────────────

export interface SettingsRequest {
    setting: AssistantSetting;
    days: number | null;
    value: ReviewAlert | null;
    enabled: boolean | null;
    monthlyCap: number | null;
}

/** Shape check on the model's output. Pure. Null when it is not a usable proposal. */
export function settingsProposalFromUiElement(uiElement: unknown): SettingsRequest | null {
    if (!uiElement || typeof uiElement !== 'object') return null;
    const ui = uiElement as Record<string, unknown>;
    if (ui.type !== ASSISTANT_SETTINGS_PROPOSAL_TYPE) return null;
    const setting = ASSISTANT_SETTINGS.find((s) => s === ui.setting);
    if (!setting) return null;
    const req: SettingsRequest = { setting, days: null, value: null, enabled: null, monthlyCap: null };
    if (setting === 'draft_horizon') {
        const d = Number(ui.days);
        if (!Number.isInteger(d)) return null;
        req.days = Math.max(MIN_HORIZON_DAYS, Math.min(MAX_HORIZON_DAYS, d));
    } else if (setting === 'review_alerts') {
        const v = REVIEW_ALERT_VALUES.find((x) => x === ui.value);
        if (!v) return null;
        req.value = v;
    } else if (setting === 'content_suggestions') {
        if (typeof ui.enabled === 'boolean') req.enabled = ui.enabled;
        if (ui.monthlyCap != null && ui.monthlyCap !== '') {
            const cap = Math.floor(Number(ui.monthlyCap));
            if (Number.isFinite(cap) && cap >= 0 && cap <= MAX_MEDIA_CAP) req.monthlyCap = cap;
        }
        if (req.enabled === null && req.monthlyCap === null) return null;
    }
    return req;
}

export interface SettingsCard {
    type: typeof ASSISTANT_SETTINGS_PROPOSAL_TYPE;
    setting: AssistantSetting;
    assistantId: number;
    assistantName: string;
    /** What it is now and what the click makes it, in the page's words. */
    current: string;
    proposed: string;
    /** The exact values the click sends. */
    days: number | null;
    value: ReviewAlert | null;
    enabled: boolean | null;
    monthlyCap: number | null;
    /** Set when the change does not apply; the card says it and offers no button. */
    blocked: string | null;
    settled?: boolean;
}

function buildCard(row: SettingsRow, roleKey: string | null | undefined, req: SettingsRequest): SettingsCard {
    const card: SettingsCard = {
        type: ASSISTANT_SETTINGS_PROPOSAL_TYPE,
        setting: req.setting,
        assistantId: row.id,
        assistantName: row.name,
        current: '',
        proposed: '',
        days: req.days,
        value: req.value,
        enabled: req.enabled,
        monthlyCap: req.monthlyCap,
        blocked: null,
    };
    if (!settingsForRole(roleKey).includes(req.setting)) {
        card.blocked = 'This assistant doesn’t have that setting.';
        return card;
    }
    const status = row.lifecycleStatus;
    switch (req.setting) {
        case 'pause':
            card.current = STATUS_WORDS[status] ?? status;
            card.proposed = 'Paused — it stops all actions until you resume it.';
            if (status === 'paused' || status === 'system_paused') card.blocked = 'It is already paused.';
            else if (status !== 'working') card.blocked = 'Only a working assistant can be paused.';
            break;
        case 'resume':
            card.current = STATUS_WORDS[status] ?? status;
            card.proposed = 'Working — the same readiness checks as Kick Off apply.';
            if (status === 'working') card.blocked = 'It is already working.';
            else if (status === 'system_paused') card.blocked = 'It was stopped because something needs fixing, usually a connection. Fix that on its page first — it starts again from there.';
            else if (status !== 'paused' && status !== 'ready_for_work') card.blocked = 'It can’t be started from here while it is ' + (STATUS_WORDS[status] ?? status) + '.';
            break;
        case 'draft_horizon':
            card.current = days(row.draftHorizonDays);
            card.proposed = days(req.days!);
            if (req.days === row.draftHorizonDays) card.blocked = `It already drafts ${days(row.draftHorizonDays)} ahead.`;
            break;
        case 'review_alerts':
            card.current = reviewLabel(row.reviewNotifPreference);
            card.proposed = reviewLabel(req.value!);
            if (req.value === row.reviewNotifPreference) card.blocked = `Review alerts are already set to ${reviewLabel(req.value!)}.`;
            break;
        case 'content_suggestions': {
            const on = req.enabled ?? row.autonomousMediaEnabled;
            const cap = req.monthlyCap ?? row.autonomousMediaMonthlyCap;
            card.current = suggestionsWords(row.autonomousMediaEnabled, row.autonomousMediaMonthlyCap);
            card.proposed = suggestionsWords(on, cap);
            if (on === row.autonomousMediaEnabled && cap === row.autonomousMediaMonthlyCap) card.blocked = `Autonomous Content Suggestions are already ${card.current}.`;
            break;
        }
    }
    return card;
}

/**
 * Check a proposal against the assistant's row and return the card the user confirms — built from the
 * row, never from the model's description. Null when the row cannot be read.
 */
export async function resolveSettingsProposal(
    db: Db, organisationId: number, aiAssistantId: number, roleKey: string | null | undefined, req: SettingsRequest,
): Promise<SettingsCard | null> {
    try {
        const row = await readRow(db, organisationId, aiAssistantId);
        return row ? buildCard(row, roleKey, req) : null;
    } catch (err) {
        console.error('[chat-assistant-settings] could not resolve the proposal (non-fatal)', err);
        return null;
    }
}

// ── Reopening a conversation ─────────────────────────────────────────────────────────────────────
// A stored card comes back on every reload. Once the change has been made (here or on the page), the
// old button would read like a fresh request — so a stored card is checked again and, when it no
// longer applies, says so instead of offering the button.

/** Re-check every stored assistant_settings_proposal in a transcript. Mutates nothing it is given. */
export async function refreshSettingsCards<M extends { uiElement: unknown }>(
    db: Db, organisationId: number, aiAssistantId: number, roleKey: string | null | undefined, messages: M[],
): Promise<M[]> {
    if (!messages.some((m) => (m.uiElement as { type?: unknown } | null)?.type === ASSISTANT_SETTINGS_PROPOSAL_TYPE)) return messages;
    let row: SettingsRow | null;
    try { row = await readRow(db, organisationId, aiAssistantId); }
    catch (err) {
        console.error('[chat-assistant-settings] could not refresh stored cards (non-fatal)', err);
        return messages;
    }
    return messages.map((m) => {
        const ui = m.uiElement as Record<string, unknown> | null;
        if (!ui || ui.type !== ASSISTANT_SETTINGS_PROPOSAL_TYPE) return m;
        const req = settingsProposalFromUiElement(ui);
        if (!req) return m;
        if (!row) return { ...m, uiElement: { ...ui, settled: true, blocked: 'This assistant no longer exists.' } };
        const now = buildCard(row, roleKey, req);
        // Still applies: keep the card as the user was shown it, with today's "current".
        if (!now.blocked) return { ...m, uiElement: { ...ui, current: now.current } };
        return { ...m, uiElement: { ...ui, current: now.current, settled: true, blocked: now.blocked } };
    });
}
