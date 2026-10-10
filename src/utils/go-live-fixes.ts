// src/utils/go-live-fixes.ts
// The "Fix" and "Suggest" buttons beside each failing go-live check on Admin ▸ Assistants.
//
// Every check (src/utils/assistant-go-live.ts) gets exactly one of four remedies:
//   fix        — a rule-based correction applied directly, because there is one right answer:
//                a "works with" typo → the real role key; a missing icon → the default; the tools it
//                connects with → the connection categories the CODE gives the role.
//   suggest    — Claude drafts wording or a choice (tagline, description, key features, category,
//                risk level, a first prompt, the special-category clause). The admin sees it in an
//                editable box and nothing is written until they press Apply.
//   goto       — needs a human decision with no sensible default (a demo video, capabilities):
//                the button opens the tab where it is set.
//   developer  — the "Built and working" checks. No button can write code.
//
// Apply goes through applyFix() → a validated column update (or a new prompt version), never a raw
// write of whatever the client sent. Pure apart from the model call, which the endpoint makes.

import { CATEGORY_LABELS, ROLE_CONNECTIONS } from './connection-map';

export type Remedy = 'fix' | 'suggest' | 'goto' | 'developer';

export const REMEDIES: Record<string, { remedy: Remedy; label?: string; tab?: 'details' | 'prompt' | 'capabilities' }> = {
    name:            { remedy: 'suggest' },
    tagline:         { remedy: 'suggest' },
    description:     { remedy: 'suggest' },
    category:        { remedy: 'suggest' },
    icon:            { remedy: 'fix' },
    keyFeatures:     { remedy: 'suggest' },
    worksWith:       { remedy: 'fix' },         // falls back to a suggestion when there is nothing to correct
    integrations:    { remedy: 'fix' },
    video:           { remedy: 'goto', label: 'Add on Details', tab: 'details' },
    version:         { remedy: 'suggest' },
    risk:            { remedy: 'suggest' },
    specialCategory: { remedy: 'suggest' },
    setup:           { remedy: 'developer' },
    chat:            { remedy: 'developer' },
    dashboard:       { remedy: 'developer' },
    rows:            { remedy: 'goto', label: 'Set capabilities', tab: 'capabilities' },
};

export const RISK_VALUES = ['minimal', 'limited', 'high_risk_borderline', 'high_risk'] as const;
export const DEFAULT_ICON = { iconKey: 'document', iconColor: 'blue' } as const;

/**
 * The clause appended when the current prompt has none. Worded as a refusal the model can follow,
 * covering the UK GDPR Article 9 list.
 */
export const SPECIAL_CATEGORY_CLAUSE = 'SPECIAL-CATEGORY DATA: Never ask for, infer, record or act on special-category personal data — health, racial or ethnic origin, political opinions, religious or philosophical beliefs, trade-union membership, genetic or biometric data, sex life or sexual orientation. If someone shares it, do not use it: say you cannot help with that information and carry on without it.';

const SPECIAL_TERMS = [/health/i, /ethnic|racial/i, /religio/i, /political/i, /sexual orientation|sex life/i, /biometric|genetic/i, /trade.union/i];

/** The sentence in a prompt that already refuses special-category data, or null. */
export function findSpecialCategoryClause(prompt: string | null | undefined): string | null {
    const text = String(prompt ?? '');
    if (!text.trim()) return null;
    const sentences = text.split(/(?<=[.!?])\s+|\n+/);
    for (const s of sentences) {
        const refuses = /never|do not|don't|must not|refuse|decline|avoid/i.test(s);
        if (!refuses) continue;
        if (/special.categor/i.test(s)) return s.trim();
        if (SPECIAL_TERMS.filter((re) => re.test(s)).length >= 3) return s.trim();
    }
    return null;
}

function editDistance(a: string, b: string): number {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    return dp[a.length][b.length];
}

/** The role key a mistyped "works with" entry most plausibly meant — only when it is close. */
export function nearestRoleKey(entry: string, known: readonly string[]): string | null {
    let best: string | null = null, bestD = Infinity;
    for (const k of known) { const d = editDistance(entry.toLowerCase(), k); if (d < bestD) { bestD = d; best = k; } }
    return best && bestD <= Math.max(2, Math.floor(entry.length / 4)) ? best : null;
}

export interface FixContext {
    roleKey: string;
    worksWith: string[];
    knownRoleKeys: readonly string[];
}

/** A proposal shown to the admin: the value Apply will write, and what it means. */
export interface Proposal {
    key: string;
    /** 'text' | 'list' (one per line) | 'choice' | 'prompt' | 'confirm' — how the box renders. */
    kind: 'text' | 'list' | 'choice' | 'prompt' | 'confirm';
    value: unknown;
    explanation: string;
    options?: readonly string[];
    /** true = deterministic; the admin can apply without reading a draft. */
    direct?: boolean;
}

/**
 * The rule-based fixes. Returns null when the check needs a suggestion (or a human) instead —
 * e.g. an EMPTY "works with" has nothing to correct, so it goes to the model.
 */
export function deterministicFix(key: string, ctx: FixContext): Proposal | null {
    if (key === 'icon') return { key, kind: 'text', value: DEFAULT_ICON, direct: true, explanation: `Sets the icon to "${DEFAULT_ICON.iconKey}" in ${DEFAULT_ICON.iconColor}. Change it on Details if you prefer another.` };
    if (key === 'worksWith') {
        if (!ctx.worksWith.length) return null;
        const fixed: string[] = []; const unfixable: string[] = [];
        for (const w of ctx.worksWith) {
            if (w === 'standalone' || ctx.knownRoleKeys.includes(w)) { fixed.push(w); continue; }
            const near = nearestRoleKey(w, ctx.knownRoleKeys);
            if (near) fixed.push(near); else unfixable.push(w);
        }
        const value = [...new Set(fixed.length ? fixed : ['standalone'])];
        return { key, kind: 'list', value, direct: true, explanation: unfixable.length
            ? `Corrects the role keys it can and drops ${unfixable.join(', ')}, which matches no assistant.`
            : 'Corrects each entry to the role key it was meant to be.' };
    }
    if (key === 'integrations') {
        const cats = ROLE_CONNECTIONS[ctx.roleKey];
        if (!cats || !cats.length) return null;
        const value = cats.map((c) => CATEGORY_LABELS[c]?.label ?? c);
        return { key, kind: 'list', value, direct: true, explanation: 'The kinds of account this assistant connects to, taken from the code (connection-map.ts) — so the card claims nothing it cannot do.' };
    }
    return null;
}

/** What the model is asked for each suggestable check. Kept here so the wording is tested and in one place. */
export function suggestionBrief(key: string, a: {
    name: string; roleKey: string; category: string | null; tagline: string | null; description: string | null;
    keyFeatures: string[]; categories: string[]; knownRoleKeys: readonly string[]; currentPrompt: string | null;
}): { ask: string; kind: Proposal['kind']; options?: readonly string[] } | null {
    const facts = [
        `Assistant: ${a.name} (role key ${a.roleKey})`,
        a.category ? `Category: ${a.category}` : '',
        a.tagline ? `Tagline: ${a.tagline}` : '',
        a.description ? `Description: ${a.description}` : '',
        a.keyFeatures.length ? `Key features: ${a.keyFeatures.join('; ')}` : '',
    ].filter(Boolean).join('\n');
    const rules = 'UK English. Plain words a small-business owner understands. Describe only what is stated above — never invent a feature, an integration, a number or a guarantee.';
    switch (key) {
        case 'name': return { kind: 'text', ask: `${facts}\n\nSuggest a short customer-facing name for this assistant (2–4 words, like "Social Media Assistant"). ${rules}\nReturn JSON: {"value": "..."}` };
        case 'tagline': return { kind: 'text', ask: `${facts}\n\nWrite a one-line tagline for its catalogue card: under 80 characters, the outcome for the customer. ${rules}\nReturn JSON: {"value": "..."}` };
        case 'description': return { kind: 'text', ask: `${facts}\n\nWrite the catalogue description: two sentences, 120–280 characters, saying what it does and why it helps. ${rules}\nReturn JSON: {"value": "..."}` };
        case 'keyFeatures': return { kind: 'list', ask: `${facts}\n\nWrite 4 key features for its detail page: each 2–6 words in Title Case, like "Briefs, Not Prompts". ${rules}\nReturn JSON: {"value": ["...", "...", "...", "..."]}` };
        case 'category': return { kind: 'choice', options: a.categories, ask: `${facts}\n\nPick the catalogue category this assistant belongs in. Choose ONLY from: ${a.categories.join(' | ')}.\nReturn JSON: {"value": "<one of them exactly>", "why": "<one sentence>"}` };
        case 'worksWith': return { kind: 'list', ask: `${facts}\n\nWhich of these assistants does it naturally work with? Choose from these role keys only: ${a.knownRoleKeys.filter((k) => k !== a.roleKey).join(', ')}. Include "standalone" if it is useful on its own. At most 3 entries.\nReturn JSON: {"value": ["..."], "why": "<one sentence>"}` };
        case 'risk': return { kind: 'choice', options: RISK_VALUES, ask: `${facts}\n\nClassify this assistant's EU AI Act risk level. "minimal" = no meaningful effect on people; "limited" = interacts with or produces content for people (transparency duties) — most marketing and admin assistants; "high_risk_borderline" / "high_risk" = decisions about employment, credit, access to services, or similar. Choose ONLY from: ${RISK_VALUES.join(' | ')}.\nReturn JSON: {"value": "<one of them>", "why": "<one sentence>"}` };
        case 'version': return { kind: 'prompt', ask: `${facts}\n\nDraft the master system prompt for this assistant: who it is, what it does, how it works with the business's own facts, what it must never do (invent facts, prices or claims; act without the user's approval; handle special-category personal data). 150–350 words, second person ("You are …"). Do not mention Be More Swan's internal systems.\nReturn JSON: {"value": "..."}` };
        default: return null;
    }
}

/** Special-category is answered without the model: confirm the clause already there, or propose adding one. */
export function specialCategoryProposal(currentPrompt: string | null): Proposal {
    const found = findSpecialCategoryClause(currentPrompt);
    if (found) return { key: 'specialCategory', kind: 'confirm', value: { confirm: true }, explanation: `The current prompt already refuses special-category data: “${found.slice(0, 300)}” Apply records that you have checked it.` };
    return { key: 'specialCategory', kind: 'prompt', value: SPECIAL_CATEGORY_CLAUSE, explanation: currentPrompt
        ? 'The current prompt has no refusal clause. Apply adds this text to the end of the prompt as a new version and records the confirmation.'
        : 'There is no prompt yet. Create one on the Prompt & versions tab (or use Suggest on "Has a current prompt version") first.' };
}

export type ApplyWrite =
    | { kind: 'columns'; set: Record<string, unknown> }
    | { kind: 'version'; systemPrompt: string; changeNote: string; alsoSet?: Record<string, unknown> };

const cleanList = (v: unknown, max: number): string[] =>
    (Array.isArray(v) ? v : typeof v === 'string' ? v.split('\n') : []).map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, max);

/**
 * Turn an applied value into a validated write. Throws Error(message) on anything invalid — the
 * endpoint returns it as a 400. Never trusts the client to pick the column.
 */
export function applyFix(key: string, value: unknown, ctx: { knownRoleKeys: readonly string[]; categories: string[]; currentPrompt: string | null }): ApplyWrite {
    const text = (max: number, min = 1) => {
        const s = typeof value === 'string' ? value.trim() : '';
        if (s.length < min) throw new Error(`Needs at least ${min} characters.`);
        return s.slice(0, max);
    };
    switch (key) {
        case 'name': return { kind: 'columns', set: { name: text(80) } };
        case 'tagline': return { kind: 'columns', set: { tagline: text(140) } };
        case 'description': return { kind: 'columns', set: { description: text(1000, 60) } };
        case 'category': return { kind: 'columns', set: { category: text(60) } };
        case 'icon': {
            const v = (value ?? {}) as { iconKey?: string; iconColor?: string };
            const iconKey = String(v.iconKey ?? DEFAULT_ICON.iconKey).trim().slice(0, 40);
            const iconColor = String(v.iconColor ?? DEFAULT_ICON.iconColor).trim().slice(0, 20);
            if (!iconKey || !iconColor) throw new Error('Both an icon and a colour are needed.');
            return { kind: 'columns', set: { iconKey, iconColor } };
        }
        case 'keyFeatures': {
            const list = cleanList(value, 8).map((x) => x.slice(0, 80));
            if (list.length < 3) throw new Error('At least 3 key features.');
            return { kind: 'columns', set: { keyFeatures: list } };
        }
        case 'worksWith': {
            const list = cleanList(value, 6);
            const bad = list.filter((w) => w !== 'standalone' && !ctx.knownRoleKeys.includes(w));
            if (!list.length) throw new Error('Add "standalone" or at least one role key.');
            if (bad.length) throw new Error(`Not a role key in the catalogue: ${bad.join(', ')}.`);
            return { kind: 'columns', set: { worksWith: list } };
        }
        case 'integrations': return { kind: 'columns', set: { integrations: cleanList(value, 12).map((x) => x.slice(0, 60)) } };
        case 'risk': {
            const v = typeof value === 'string' ? value.trim() : '';
            if (!(RISK_VALUES as readonly string[]).includes(v)) throw new Error(`Risk must be one of ${RISK_VALUES.join(', ')}.`);
            return { kind: 'columns', set: { riskClassification: v } };
        }
        case 'version': return { kind: 'version', systemPrompt: text(20_000, 80), changeNote: 'First prompt — drafted with Suggest on Admin ▸ Assistants and approved' };
        case 'specialCategory': {
            if (value && typeof value === 'object' && (value as { confirm?: boolean }).confirm === true) {
                if (!findSpecialCategoryClause(ctx.currentPrompt)) throw new Error('The current prompt has no refusal clause to confirm.');
                return { kind: 'columns', set: { specialCategoryClauseEnabled: true } };
            }
            if (!ctx.currentPrompt) throw new Error('Create a prompt first.');
            const clause = text(2000, 40);
            return { kind: 'version', systemPrompt: `${ctx.currentPrompt.trimEnd()}\n\n${clause}`, changeNote: 'Added the special-category refusal clause (Admin ▸ Assistants)', alsoSet: { specialCategoryClauseEnabled: true } };
        }
        default: throw new Error('This check cannot be fixed from here.');
    }
}
