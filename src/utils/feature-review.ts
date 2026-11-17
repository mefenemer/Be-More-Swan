// src/utils/feature-review.ts — "Review with AI" on an admin feature request (owner 2026-11-17).
// Opus 5.5 reviews the request against a FIXED set of headings (owner's list + four of Claude's), gives a
// one-line verdict per heading and suggests improvements; the admin ticks the ones to keep and only those
// are added to the description (or the brief). Nothing is saved until the admin presses Save.

export const FEATURE_REVIEW_MODEL = 'claude-opus-5-5';
export const MAX_SUGGESTIONS_PER_AREA = 2;

/** The review headings, in the order shown. The first nine are the owner's (2026-11-17); the rest Claude's. */
export const REVIEW_AREAS = [
    { key: 'ux', label: 'UX', ask: 'the user journey: steps, effort, clarity, what the user sees first, onboarding' },
    { key: 'ui', label: 'UI', ask: 'layout, controls, wording on screen, phone width, consistency with the rest of the app' },
    { key: 'performance', label: 'Performance', ask: 'speed, timeouts, background work, and the cost to run (AI calls, storage)' },
    { key: 'disruptive', label: 'Disruptive', ask: 'whether it changes how small businesses do this today, or is an incremental tweak' },
    { key: 'value', label: 'Value', ask: 'the concrete outcome for the customer (time saved, revenue, fewer mistakes)' },
    { key: 'will_pay', label: 'Will people pay', ask: 'whether customers would pay for it, which plan it belongs on, upgrade pull' },
    { key: 'uniqueness', label: 'Uniqueness in the market', ask: 'how it compares with what competitors and general tools already offer' },
    { key: 'connections', label: 'Connections', ask: 'links with the other AI assistants and with external tools / integrations' },
    { key: 'gui_chat', label: 'GUI and chat completeness', ask: 'every capability must work both from the screens AND by asking the assistant in chat' },
    { key: 'privacy', label: 'Privacy & security', ask: 'personal data, permissions, roles, UK GDPR, abuse' },
    { key: 'edge_cases', label: 'Edge cases & errors', ask: 'empty states, failures, limits, disconnected accounts, what happens on retry' },
    { key: 'accessibility', label: 'Accessibility', ask: 'keyboard, screen readers, contrast, plain language' },
    { key: 'scope', label: 'Scope & phasing', ask: 'whether it should be split, what a first phase is, what to leave out' },
] as const;

export type ReviewArea = typeof REVIEW_AREAS[number]['key'];
export type ReviewTarget = 'description' | 'brief';
const AREA_KEYS = new Set<string>(REVIEW_AREAS.map(a => a.key));
export const areaLabel = (key: string) => REVIEW_AREAS.find(a => a.key === key)?.label ?? key;

export interface ReviewSuggestion {
    id: string;
    area: ReviewArea;
    /** Short heading, e.g. "Say what happens when the list is empty". */
    title: string;
    /** The sentence(s) to add if the admin keeps it. */
    detail: string;
    /** Where it belongs: the request itself, or the brief Claude builds from. */
    target: ReviewTarget;
}

export interface FeatureReview {
    summary: string;
    /** One line per heading, in REVIEW_AREAS order; every heading is present. */
    areas: Array<{ key: ReviewArea; label: string; verdict: string }>;
    suggestions: ReviewSuggestion[];
}

export function buildReviewPrompt(input: { title: string; description?: string; brief?: string }): string {
    const desc = (input.description || '').trim() || '(none provided)';
    const brief = (input.brief || '').trim() || '(none yet)';
    return [
        'You are a senior product manager reviewing a feature request for Be More Swan, a SaaS platform where small',
        'businesses hire AI assistants (social media, blog, email, website, leads and more). The request will be',
        'built by an AI coding agent from its description and brief, so gaps become wrong guesses.',
        '',
        'Review the request under EVERY one of these headings (key: what to look at):',
        ...REVIEW_AREAS.map(a => `- ${a.key}: ${a.ask}`),
        '',
        'For each heading give a verdict of at most 20 words, then 0 to ' + MAX_SUGGESTIONS_PER_AREA + ' suggestions. Only suggest what would',
        'genuinely improve the request; if a heading is already covered or does not apply, say so and suggest nothing.',
        'Do not restate what is already there and do not invent facts about the codebase (file paths, table names).',
        'Each suggestion must stand on its own (the admin keeps some and drops others), with a detail of at most two',
        'sentences written ready to paste. Use target "brief" for build detail (acceptance criteria, edge cases, limits)',
        'and "description" for what the feature is, who it is for and why.',
        '',
        'Reply with ONLY a JSON object, no markdown fence, in exactly this shape:',
        '{"summary":"one or two sentences on the request overall","areas":[{"key":"ux","verdict":"...","suggestions":[{"title":"short heading","detail":"text to add","target":"description"}]}]}',
        '',
        `Title: """${input.title.trim()}"""`,
        `Description: """${desc}"""`,
        `Brief: """${brief}"""`,
    ].join('\n');
}

/** Pulls the JSON object out of the model's reply, tolerating a stray fence or preamble. */
export function parseReview(raw: string): FeatureReview {
    const text = (raw || '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('No JSON in the review.');
    const parsed = JSON.parse(text.slice(start, end + 1));
    const summary = typeof parsed?.summary === 'string' ? parsed.summary.trim() : '';
    const byKey = new Map<string, any>();
    for (const a of Array.isArray(parsed?.areas) ? parsed.areas : []) {
        if (typeof a?.key === 'string' && AREA_KEYS.has(a.key) && !byKey.has(a.key)) byKey.set(a.key, a);
    }
    const areas: FeatureReview['areas'] = [];
    const suggestions: ReviewSuggestion[] = [];
    for (const def of REVIEW_AREAS) {
        const a = byKey.get(def.key);
        const verdict = typeof a?.verdict === 'string' ? a.verdict.trim().slice(0, 300) : '';
        areas.push({ key: def.key, label: def.label, verdict: verdict || 'Not reviewed.' });
        let n = 0;
        for (const s of Array.isArray(a?.suggestions) ? a.suggestions : []) {
            const title = typeof s?.title === 'string' ? s.title.trim() : '';
            const detail = typeof s?.detail === 'string' ? s.detail.trim() : '';
            if (!title || !detail) continue;
            suggestions.push({
                id: `s${suggestions.length + 1}`, area: def.key,
                title: title.slice(0, 200), detail: detail.slice(0, 2000),
                target: s?.target === 'brief' ? 'brief' : 'description',
            });
            if (++n >= MAX_SUGGESTIONS_PER_AREA) break;
        }
    }
    if (!byKey.size && !summary) throw new Error('Empty review.');
    return { summary, areas, suggestions };
}

/** Appends the kept suggestions to existing text, grouped by heading; unchanged when none are kept. */
export function appendSuggestions(existing: string, picked: Array<Pick<ReviewSuggestion, 'area' | 'title' | 'detail'>>): string {
    if (!picked.length) return existing;
    const lines = picked.map(s => `- [${areaLabel(s.area)}] ${s.title}: ${s.detail}`).join('\n');
    const base = (existing || '').replace(/\s+$/, '');
    return base ? `${base}\n\nImprovements (AI review):\n${lines}` : `Improvements (AI review):\n${lines}`;
}
