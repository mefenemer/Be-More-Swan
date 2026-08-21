/**
 * src/config/assistant-colors.ts
 *
 * The palette an assistant's icon can be drawn in, and the rule for validating a stored choice.
 *
 * The colour is the user's to pick (assistant detail → the swatch beside the name) and is stored on
 * the assistant as `configuration.avatarColor`. It is rendered by interpolating the value into a
 * `style="background:…"` attribute on several surfaces, so it is NEVER free text: only a value from
 * this list may be persisted, and anything else is treated as "not set" rather than written through.
 *
 * ⚠️ Do not hand-copy this palette into the browser. The client's copy is GENERATED into
 * src/generated/platform-constants.js (npm run gen:constants) and read via window.AssistantColors —
 * the id-derived fallback below has to agree exactly between server and client, or an assistant
 * nobody has styled would look like a different colour depending on which side answered.
 */

export interface AssistantColor {
    /** The hex value stored and rendered. Lower-case; comparisons normalise to it. */
    value: string;
    /** Human name — a swatch needs one to be labelled accessibly rather than being a bare square. */
    name: string;
}

export const ASSISTANT_COLORS: readonly AssistantColor[] = [
    { value: '#6366f1', name: 'Indigo' },
    { value: '#10b981', name: 'Green' },
    { value: '#f59e0b', name: 'Amber' },
    { value: '#ec4899', name: 'Pink' },
    { value: '#06b6d4', name: 'Cyan' },
    { value: '#8b5cf6', name: 'Violet' },
    { value: '#ef4444', name: 'Red' },
    { value: '#14b8a6', name: 'Teal' },
    { value: '#f97316', name: 'Orange' },
    { value: '#3b82f6', name: 'Blue' },
] as const;

export const ASSISTANT_COLOR_VALUES: readonly string[] = ASSISTANT_COLORS.map(c => c.value);

/** Drawn for rows that belong to no assistant — the "Be More Swan" system actor. Not assignable. */
export const ASSISTANT_COLOR_NEUTRAL = '#9ca3af';

/**
 * The stored value, or null when there is nothing valid to store.
 *
 * Returns null for an unknown colour rather than throwing or substituting one: a caller sending
 * junk should end up with the automatic colour, and a caller sending null is explicitly resetting
 * to automatic. Both are "no override".
 */
export function normaliseAssistantColor(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const v = raw.trim().toLowerCase();
    return ASSISTANT_COLOR_VALUES.includes(v) ? v : null;
}

/**
 * The colour an assistant with no explicit choice is drawn in — stable per id, so it does not
 * depend on the order a surface happened to load its assistants in.
 *
 * ⚠️ This is the behaviour that already shipped in notifications.js, kept so that turning the
 * feature on repaints nobody. calendar.js used the assistant's INDEX in its loaded list instead,
 * which is why the same assistant could be two different colours on two pages.
 */
export function autoAssistantColor(id: number | string | null | undefined): string {
    if (id === null || id === undefined) return ASSISTANT_COLOR_NEUTRAL;
    const n = Number(id);
    if (!Number.isFinite(n)) return ASSISTANT_COLOR_NEUTRAL;
    return ASSISTANT_COLOR_VALUES[Math.abs(Math.trunc(n)) % ASSISTANT_COLOR_VALUES.length];
}
