// src/utils/setup-field.ts
// Changing one set-up answer from chat (docs/business-mentor-plan.md §3.4): the `setup_field_proposal`
// card. Pure, so the chat route (to build the card), update-assistant-context.ts (to check the write)
// and the coverage test all read the same rules.
//
//   - The questions are the role's own set-up questions (src/public/assistant-onboarding-schemas.js),
//     plus the Social Media wizard's (onboarding-social-media.html), listed separately below because
//     that wizard is its own page.
//   - Every question is either changeable here or EXCLUDED with the reason — tests/setup-field.test.ts
//     fails on a new question that is neither, so a field added to a wizard can't silently become
//     something chat can't change.
//   - The write sends ONLY the changed key (update-assistant-context.ts `patchContext`), merged onto
//     the row read inside the save, so a card drawn an hour ago can't overwrite other answers.

import schemas from '../public/assistant-onboarding-schemas.js';
import type { SchemaField } from '../public/assistant-onboarding-schemas.js';
import { SMM_ROLE_KEYS } from '../constants/roles';

export const SETUP_FIELD_CARD_TYPE = 'setup_field_proposal';

/** One changeable question: what the card shows and what a value must be. */
export interface SetupFieldDef {
    key: string;
    label: string;
    type: SchemaField['type'];
    required: boolean;
    options: Array<{ value: string; label: string }> | null;
    min: number | null;
    max: number | null;
    /** Longest text accepted. */
    maxLength: number;
    /** The option a blank answer already behaves as, or null when blank means nothing. */
    blankMeans: string | null;
}

const TEXT_MAX = 200;
const TEXTAREA_MAX = 2000;

/**
 * The Social Media wizard's answers (onboarding-social-media.html → structuredContext). The social role
 * has no entry in assistant-onboarding-schemas.js, so its questions are listed here by hand.
 */
export const SOCIAL_WIZARD_FIELDS: readonly SchemaField[] = [
    { key: 'primary_objective', label: 'Main goal', type: 'radio', required: true, options: [
        { value: 'brand_awareness', label: 'Brand awareness' }, { value: 'lead_generation', label: 'Lead generation' },
        { value: 'direct_sales', label: 'Direct sales' }, { value: 'community_engagement', label: 'Community engagement' },
    ] },
    { key: 'core_message', label: 'Core message', type: 'textarea' },
    { key: 'incentive', label: 'Incentive or offer', type: 'text' },
    { key: 'target_audience', label: 'Target audience', type: 'textarea' },
    { key: 'content_pillars', label: 'Content pillars', type: 'textarea' },
    { key: 'sales_objections', label: 'Objections to answer', type: 'textarea' },
    { key: 'tone_of_voice', label: 'Tone of voice', type: 'text' },
    { key: 'problem_statement', label: 'The problem you solve', type: 'textarea' },
    { key: 'reference_style_url', label: 'A post style you like (link)', type: 'text' },
];

/** The Social wizard's answers that are NOT changed by this card, and why. */
export const SOCIAL_WIZARD_EXCLUDED: Readonly<Record<string, string>> = {
    cta: 'The call to action has its own card (chat-call-to-action.ts) and setting on Products & Services.',
    posting_frequency: 'Part of the Posting Schedule — the schedule card (chat-schedule.ts) changes all four schedule keys together.',
    posting_days: 'Part of the Posting Schedule (schedule card).',
    posting_times: 'Part of the Posting Schedule (schedule card).',
    posting_timezone: 'Part of the Posting Schedule (schedule card).',
    trigger_type: 'How posts are triggered — "When and how I post" on the profile; changing it alone would leave the schedule inconsistent.',
    trigger_schedule_frequency: 'Set with trigger_type on the profile.',
    trigger_timezone: 'Set with trigger_type on the profile.',
    content_source: 'Where content comes from — set on the profile with its detail.',
    content_source_detail: 'Set with content_source on the profile.',
    primary_platforms: 'Which platforms it posts to — the platform switches card (chat-platforms.ts).',
    platform_strategy: 'A per-platform object (hashtags, algorithm notes) edited on the profile, not one value.',
};

/** Set-up questions in assistant-onboarding-schemas.js that this card does NOT change, and why. */
export const SETUP_FIELD_EXCLUDED: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    business_mentor: {
        businessStage: 'Asked by its own question card (mentor_business_stage), with both answers as buttons.',
        quietMode: 'Its own Quiet mode card (mentor_quiet_mode).',
    },
    blog_writer: {
        posting_frequency: 'Part of the Posting Schedule — the schedule card changes it.',
        draft_horizon_days: '"Generate posts ahead" — the settings card (chat-assistant-settings.ts draft_horizon) changes it.',
    },
    lead_qualifier: {
        outreachEmailProvider: 'Choosing a mailbox means signing in to it on the Connections page; a value alone would break sending.',
        outreachOffer: 'Its own card (chat-outreach-offer.ts), which checks the gift form exists.',
    },
    accounts_receivable_clerk: {
        accountingPlatform: 'Names a connected tool: switching it means connecting the new one first.',
    },
    crm_enricher: {
        primaryCrm: 'Names a connected tool: switching it means connecting the new one first.',
    },
    tier1_support_agent: {
        helpdeskPlatform: 'Names a connected tool: switching it means connecting the new one first.',
        escalationEmail: 'An email address — the user types it on the page; chat never proposes contact details.',
    },
    meeting_note_taker: {
        meetingPlatform: 'Names a connected tool: switching it means connecting the new one first.',
        taskDestination: 'Names a connected tool: switching it means connecting the new one first.',
    },
};

/** Every set-up question a role has (schema, or the Social wizard's), changeable or not. */
export function allSetupFields(roleKey: string): readonly SchemaField[] {
    if (SMM_ROLE_KEYS.includes(roleKey)) return SOCIAL_WIZARD_FIELDS;
    const steps = (schemas as Record<string, Array<{ fields: SchemaField[] }>>)[roleKey];
    return steps ? steps.flatMap((s) => s.fields) : [];
}

/** Why this question isn't changeable by the card, or null when it is. */
export function exclusionReason(roleKey: string, key: string): string | null {
    if (SMM_ROLE_KEYS.includes(roleKey)) return SOCIAL_WIZARD_EXCLUDED[key] ?? null;
    return SETUP_FIELD_EXCLUDED[roleKey]?.[key] ?? null;
}

function toDef(f: SchemaField): SetupFieldDef {
    return {
        key: f.key, label: f.label, type: f.type, required: !!f.required,
        options: f.options?.length ? f.options.map((o) => ({ value: String(o.value), label: o.label })) : null,
        min: typeof f.min === 'number' ? f.min : null,
        max: typeof f.max === 'number' ? f.max : null,
        maxLength: f.type === 'textarea' ? TEXTAREA_MAX : TEXT_MAX,
        blankMeans: typeof f.blankMeans === 'string' ? f.blankMeans : null,
    };
}

/** The questions the card may change for this role. */
export function changeableSetupFields(roleKey: string): SetupFieldDef[] {
    return allSetupFields(roleKey).filter((f) => !exclusionReason(roleKey, f.key)).map(toDef);
}

export function setupFieldDef(roleKey: string, key: string): SetupFieldDef | null {
    return changeableSetupFields(roleKey).find((f) => f.key === key) ?? null;
}

/**
 * Excluded questions whose OWN card also writes through `patchContext` (mentor-apply.js), so the write
 * accepts them even though the generic card doesn't offer them.
 */
export const OWN_CARD_PATCH_KEYS: Readonly<Record<string, readonly string[]>> = {
    business_mentor: ['businessStage', 'quietMode'],
};

/** The question a `patchContext` write may set: a changeable one, or one with its own card. */
export function patchableSetupFieldDef(roleKey: string, key: string): SetupFieldDef | null {
    if (OWN_CARD_PATCH_KEYS[roleKey]?.includes(key)) {
        const f = allSetupFields(roleKey).find((x) => x.key === key);
        return f ? toDef(f) : null;
    }
    return setupFieldDef(roleKey, key);
}

/**
 * Pure: a proposed value checked against its question. Options must be one of the listed values (the
 * model may give the label — it's mapped back); numbers in range; text trimmed and capped. A required
 * question can't be emptied.
 */
export function validateSetupValue(def: SetupFieldDef, raw: unknown): { ok: true; value: string | number } | { ok: false; error: string } {
    if (def.options) {
        const s = String(raw ?? '').trim();
        const hit = def.options.find((o) => o.value === s) ?? def.options.find((o) => o.label.toLowerCase() === s.toLowerCase());
        if (!hit) return { ok: false, error: `"${def.label}" must be one of: ${def.options.map((o) => o.label).join(', ')}.` };
        return { ok: true, value: hit.value };
    }
    if (def.type === 'number') {
        const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
        if (!Number.isFinite(n)) return { ok: false, error: `"${def.label}" needs a number.` };
        if (def.min !== null && n < def.min) return { ok: false, error: `"${def.label}" can't be less than ${def.min}.` };
        if (def.max !== null && n > def.max) return { ok: false, error: `"${def.label}" can't be more than ${def.max}.` };
        return { ok: true, value: n };
    }
    if (typeof raw !== 'string' && typeof raw !== 'number') return { ok: false, error: `"${def.label}" needs some text.` };
    const t = String(raw).trim();
    if (!t && def.required) return { ok: false, error: `"${def.label}" is required, so it can't be emptied.` };
    if (t.length > def.maxLength) return { ok: false, error: `"${def.label}" is too long (at most ${def.maxLength} characters).` };
    return { ok: true, value: t };
}

const isBlank = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length);

/**
 * Pure: an answer as the card shows it — an option's label, not its stored value. A blank answer that
 * already behaves as an option says so, or the model reads "Not answered" as "off".
 */
export function displaySetupValue(def: SetupFieldDef, value: unknown): string {
    if (isBlank(value)) {
        const means = def.blankMeans ? def.options?.find((o) => o.value === def.blankMeans)?.label : null;
        return means ? `Not answered, so it works as "${means}"` : 'Not answered';
    }
    if (Array.isArray(value)) return value.join(', ');
    const s = String(value);
    return def.options?.find((o) => o.value === s)?.label ?? s;
}

/**
 * Same value? (so a card never proposes what is already saved — or what a blank answer already does).
 * `a` is the saved answer, `b` the proposed one.
 */
export function sameSetupValue(a: unknown, b: unknown, def?: SetupFieldDef): boolean {
    const norm = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim());
    if (def?.blankMeans && isBlank(a)) return norm(b) === def.blankMeans || norm(b) === '';
    return norm(a) === norm(b);
}

/**
 * Pure: the set-up questions of one assistant for a prompt, with their current answers, so the model
 * names a real key and a real option. Long answers are cut.
 */
export function renderSetupFields(roleKey: string, ctx: Record<string, unknown> | null): string[] {
    return changeableSetupFields(roleKey).map((d) => {
        const cur = displaySetupValue(d, ctx?.[d.key]);
        const shown = cur.length > 100 ? `${cur.slice(0, 100)}…` : cur;
        const kind = d.options ? `one of ${d.options.map((o) => `"${o.value}" (${o.label})`).join(', ')}`
            : d.type === 'number' ? `a number${d.min !== null ? `, at least ${d.min}` : ''}${d.max !== null ? `, at most ${d.max}` : ''}`
                // The limit is stated so a draft fits first time: unstated, the Mentor wrote a 260-character
                // "Who is NOT a customer?" and the card was refused (validateSetupValue).
                : `text, at most ${d.maxLength} characters`;
        return `  - ${d.key} — "${d.label}": now ${JSON.stringify(shown)}; ${kind}`;
    });
}
