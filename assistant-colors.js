// assistant-colors.js
//
// ONE source of truth for the colour an assistant's icon is drawn in, shared by every workspace
// surface that renders one: the My Assistants cards, the detail page hero avatar, the calendar
// (legend, post chips, activity dots, filter pills) and the notification inbox (avatars, actor
// eyebrow, group headers).
//
// Before this module the colour was derived from the assistant's id, in two places that disagreed:
// notifications.js keyed the palette by `id % PALETTE.length`, while calendar.js keyed it by the
// assistant's INDEX in the loaded list. Those agree only when load order happens to match id order,
// so the same assistant could be indigo in the inbox and amber on the calendar — the exact opposite
// of the "one assistant, one colour" the comments in both files claimed.
//
// The colour is now the user's to choose (assistant detail → the pencil beside the name), stored on
// the assistant as `configuration.avatarColor`. An assistant that has never been given one keeps the
// old id-derived colour, so nothing changes appearance until someone picks.
window.AssistantColors = (function () {
    // The palette is GENERATED from src/config/assistant-colors.ts into platform-constants.js
    // (npm run gen:constants), which workspace.html loads before this file. The literals below are
    // only a last-resort fallback for the load order going wrong — they are the same values, and
    // the generated copy wins whenever it is present, so the two can never disagree in practice.
    const GEN = (typeof window !== 'undefined' && window.AssistantColorPalette) || null;
    const PALETTE = (GEN && GEN.colors) || [
        { value: '#6366f1', name: 'Indigo' }, { value: '#10b981', name: 'Green' },
        { value: '#f59e0b', name: 'Amber' },  { value: '#ec4899', name: 'Pink' },
        { value: '#06b6d4', name: 'Cyan' },   { value: '#8b5cf6', name: 'Violet' },
        { value: '#ef4444', name: 'Red' },    { value: '#14b8a6', name: 'Teal' },
        { value: '#f97316', name: 'Orange' }, { value: '#3b82f6', name: 'Blue' },
    ];
    const VALUES = (GEN && GEN.values) || PALETTE.map(c => c.value);
    // Used for "no assistant" / system rows (the "Be More Swan" actor), never assignable.
    const NEUTRAL = (GEN && GEN.neutral) || '#9ca3af';

    // Every resolved colour is interpolated into a style attribute, so nothing outside the palette
    // may ever come back — a stored value that isn't one of ours is treated as unset, not rendered.
    const isValid = (c) => typeof c === 'string' && VALUES.includes(c.toLowerCase());

    // The pre-existing behaviour, kept as the fallback for assistants nobody has styled: a stable
    // colour derived from the id (load-order independent, unlike calendar.js's old index lookup).
    const autoColor = (id) => {
        if (id == null) return NEUTRAL;
        const n = Number(id);
        if (!Number.isFinite(n)) return NEUTRAL;
        return VALUES[Math.abs(Math.trunc(n)) % VALUES.length];
    };

    // Surfaces that only hold an assistant id (a calendar chip, a notification actor) look the
    // colour up here rather than each keeping its own copy of the org's assistants.
    const _explicit = new Map();

    // Record what an assistant record says about its colour. Accepts the shapes the various
    // endpoints return — `avatarColor` at the top level (get-assistants, notification actors) or
    // nested under `configuration` (get-assistant-context).
    const remember = (assistant) => {
        if (!assistant) return;
        const id = assistant.id ?? assistant.assistantId;
        if (id == null) return;
        const raw = assistant.avatarColor ?? (assistant.configuration && assistant.configuration.avatarColor);
        // An assistant that has been reset back to automatic must DROP its cached override, or the
        // stale one outlives the reset until the next full page load.
        if (isValid(raw)) _explicit.set(String(id), raw.toLowerCase());
        else _explicit.delete(String(id));
    };

    const rememberAll = (assistants) => (assistants || []).forEach(remember);

    // The colour to draw. `explicit` lets a caller that already holds the record skip the cache.
    const colorFor = (id, explicit) => {
        if (isValid(explicit)) return explicit.toLowerCase();
        if (id == null) return NEUTRAL;
        const cached = _explicit.get(String(id));
        return isValid(cached) ? cached : autoColor(id);
    };

    const nameOf = (value) => (PALETTE.find(c => c.value === String(value).toLowerCase()) || {}).name || 'Automatic';

    return { PALETTE, VALUES, NEUTRAL, isValid, autoColor, colorFor, remember, rememberAll, nameOf };
})();
