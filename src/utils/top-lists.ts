// src/utils/top-lists.ts
//
// Top lists ("7 ways to…", "Top 5…") — feature request #34, docs/top-lists-plan.md (owner agreed all six
// decisions 2026-11-15). Lists are a FORMAT inside the existing Social and Blog assistants, not a new
// assistant: the "list" shape / article type in content-shapes.ts carries the brief, and this module
// holds the rules every list follows plus the one check the model is never trusted with.
//
// ⚠️ The number in a list's title is COMPUTED FROM THE FINISHED LIST, never taken from the model
// (plan §5.1). A model asked for "Top 7" that only has five real items should write five — and then
// it routinely leaves "7" in the headline. fixListCount() rewrites the title's number to the count of
// items actually written. tests/top-lists.test.ts holds the two together.
//
// Kept free of DB/SDK imports so the drafters, the chat orchestrator and the tests can all use it.

/** The rules every list piece follows (plan §5). Written to the model inside the list briefs. */
export const TOP_LIST_RULES = [
    'REAL ITEMS ONLY: every item comes from this business\'s own products, services, knowledge, FAQs or inspo — or is genuinely useful, specific advice in its field. If you cannot fill the number with real items, write FEWER items and put the real count in the title. Never pad.',
    'NO INVENTED STATISTICS in any item ("3. 73% of customers…" is exactly the mistake to avoid).',
    'NO SELF-CROWNING: never write "the best [category] in [town]" with this business at number one. A comparison names real alternatives, says plainly that this business is one of them, and gives honest pros and cons.',
    'SUBSTANCE IN EVERY ITEM: no one-word bullets.',
    'NO BAIT TITLES: never "you won\'t believe #4". The title states the real count and the real topic.',
].join(' ');

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
    'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];

/** A list of fewer than 2 or more than 20 items is not a "top N" we would title. */
export const MIN_LIST_ITEMS = 2;
export const MAX_LIST_ITEMS = 20;

/**
 * How many numbered items a social caption holds: lines starting "1." / "1)" / "1 -" / "1️⃣".
 * Only a run that starts at 1 counts, so a stray "2024." line is not mistaken for an item.
 */
export function countCaptionItems(caption: string): number {
    const nums: number[] = [];
    for (const line of String(caption || '').split(/\r?\n/)) {
        const m = line.match(/^\s*(?:\*\*)?(\d{1,2})(?:️?⃣|[.)]|\s[-–—:])\s*\S/);
        if (m) nums.push(Number(m[1]));
    }
    return sequentialRun(nums);
}

/**
 * How many numbered items a blog body holds: level-2 headings that start with a number
 * ("## 1. Book early", "## 3) Ask for…"). Unnumbered headings (intro, close) are not items.
 */
export function countArticleItems(markdown: string): number {
    const nums: number[] = [];
    for (const line of String(markdown || '').split(/\r?\n/)) {
        const m = line.match(/^##\s+(?:\*\*)?(\d{1,2})[.):]\s*\S/);
        if (m) nums.push(Number(m[1]));
    }
    return sequentialRun(nums);
}

/** The length of the run 1, 2, 3… at the start of `nums` (duplicates and gaps end it). */
function sequentialRun(nums: number[]): number {
    let n = 0;
    for (const x of nums) {
        if (x === n + 1) n = x;
        else if (n > 0) break;
    }
    return n;
}

/**
 * Rewrite the count in a list's title to `count`. Only the FIRST number in the text is touched, and
 * only when it reads as a list count (2–20, as digits or a word); a title with no such number is
 * returned unchanged — this fixes a wrong count, it does not invent one. Keeps the form the writer
 * used: "7 ways" → "5 ways", "Seven ways" → "Five ways", "Top 10" → "Top 6".
 */
export function fixListCount(title: string, count: number): string {
    const text = String(title ?? '');
    if (!Number.isInteger(count) || count < MIN_LIST_ITEMS || count > MAX_LIST_ITEMS) return text;
    const re = new RegExp(`\\b(\\d{1,4}|${NUMBER_WORDS.join('|')})\\b`, 'i');
    const m = text.match(re);
    if (!m || m.index == null) return text;
    const raw = m[1];
    const isDigits = /^\d+$/.test(raw);
    const value = isDigits ? Number(raw) : NUMBER_WORDS.indexOf(raw.toLowerCase());
    // A year, a price, "24/7" — anything outside list range is not the count. Leave it.
    if (value < MIN_LIST_ITEMS || value > MAX_LIST_ITEMS || value === count) return text;
    // "24/7", "3.5", "£5": a number touching a slash, a decimal point or a currency sign is not a count.
    const before = text.slice(Math.max(0, m.index - 1), m.index);
    const after = text.slice(m.index + raw.length, m.index + raw.length + 2);
    if (/[/£$€.,]/.test(before) || /^[/.,]\d|^%|^\//.test(after)) return text;
    let replacement: string;
    if (isDigits) replacement = String(count);
    else {
        const word = NUMBER_WORDS[count];
        replacement = raw === raw.toUpperCase() ? word.toUpperCase()
            : raw[0] === raw[0].toUpperCase() ? word[0].toUpperCase() + word.slice(1)
                : word;
    }
    return text.slice(0, m.index) + replacement + text.slice(m.index + raw.length);
}

/**
 * A social list caption with its opening line's count made to match the items written. Only the
 * FIRST line is the "title" of a social post; the items themselves are never renumbered.
 */
export function fixCaptionListCount(caption: string): string {
    const text = String(caption ?? '');
    const n = countCaptionItems(text);
    if (n < MIN_LIST_ITEMS) return text;
    const nl = text.indexOf('\n');
    const first = nl < 0 ? text : text.slice(0, nl);
    // The first line IS item 1 (no intro line): nothing to fix.
    if (/^\s*(?:\*\*)?1(?:️?⃣|[.)])/.test(first)) return text;
    const fixed = fixListCount(first, n);
    return fixed === first ? text : fixed + (nl < 0 ? '' : text.slice(nl));
}

/**
 * A blog list article's title and body with their counts made to match the numbered items. The body's
 * level-1 heading is fixed too, so the page and the post record never disagree.
 */
export function fixArticleListCount(title: string, bodyMarkdown: string): { title: string; bodyMarkdown: string; count: number } {
    const n = countArticleItems(bodyMarkdown);
    if (n < MIN_LIST_ITEMS) return { title, bodyMarkdown, count: n };
    const body = String(bodyMarkdown ?? '').replace(/^(#\s+)(.+)$/m, (_all, hash: string, h1: string) => hash + fixListCount(h1, n));
    return { title: fixListCount(title, n), bodyMarkdown: body, count: n };
}
