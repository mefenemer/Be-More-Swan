// src/utils/offerings-import.ts
// Moving the old free-text "Products & Services" notes into Business Information.
//
// Products and prices are kept in ONE place — Business Information ▸ Products & Services
// (owner, 2026-10-21). The Creative Brief and the social onboarding form used to keep their own
// box (`service_offerings`), typed as a sentence: "1:1 coaching (£500/mo), Free 15-min discovery
// call, Self-paced course (£199)". This splits such a sentence into catalogue rows the owner checks
// before anything is saved — a PROPOSAL, shown as editable rows; nothing is created here.
//
// Deliberately no AI: the owner's own words, cut at the obvious seams, with the price lifted out
// only when it is plainly marked. Anything ambiguous stays in the name for them to fix.

export interface OfferingDraft {
    name: string;
    /** The owner's own price words, or '' — the endpoint turns it into a structured price. */
    price: string;
    kind: 'product' | 'service';
}

export const MAX_IMPORT_ITEMS = 30;

// Words that make an entry something booked or delivered rather than a thing sold.
const SERVICE_WORDS = /\b(call|session|coaching|consult\w*|class(es)?|course|lesson|appointment|treatment|programme|program|workshop|audit|retainer|service|therapy|massage|haircut|training|mentoring|review)\b/i;

/** Split at top-level separators — never inside brackets, so "(£500/mo, billed yearly)" stays whole. */
function splitTopLevel(s: string, seps: RegExp): string[] {
    const out: string[] = [];
    let depth = 0;
    let cur = '';
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '(' || ch === '[') depth++;
        if ((ch === ')' || ch === ']') && depth > 0) depth--;
        if (depth === 0 && seps.test(ch)) { out.push(cur); cur = ''; continue; }
        cur += ch;
    }
    out.push(cur);
    return out;
}

/** One entry → name + price. A price is lifted only when it carries a currency sign or "free". */
function parseEntry(raw: string): OfferingDraft | null {
    let t = raw.replace(/^\s*(?:[-*•·–]|\d+[.)])\s*/, '').replace(/\s+/g, ' ').trim();
    if (!t) return null;
    let price = '';
    // "Name (£500/mo)" — a bracket at the end holding a price.
    let m = /^(.*?)\s*\(([^()]*(?:[£$€]\s*\d|\bfree\b)[^()]*)\)\s*\.?$/i.exec(t);
    if (m && m[1].trim()) { t = m[1].trim(); price = m[2].trim(); }
    else {
        // "Name — £500", "Name: £500", "Name - from £50 a month", "Name @ £20"
        m = /^(.*?)\s*(?:[—–:@]|\s-\s)\s*((?:from\s+)?[£$€]\s*\d.*)$/i.exec(t);
        if (m && m[1].trim()) { t = m[1].trim(); price = m[2].trim(); }
        else {
            // "Name £29/mo", "Name £15 a month" — a price written straight after the name.
            m = /^(.*?)\s+((?:from\s+)?[£$€]\s*\d[\d.,]*(?:\s*\/\s*[a-z]+|\s+(?:a|per|each)\s+[a-z]+)?)$/i.exec(t);
            if (m && m[1].trim()) { t = m[1].trim(); price = m[2].trim(); }
        }
    }
    // "Free 15-min discovery call" — leave the name whole; "free" is its price.
    if (!price && /^free\b/i.test(t)) price = 'Free';
    const name = t.replace(/[.;,]+$/, '').slice(0, 120).trim();
    if (!name) return null;
    return { name, price: price.slice(0, 120), kind: SERVICE_WORDS.test(name) ? 'service' : 'product' };
}

/** The old notes as catalogue rows to review. Pure. */
export function splitOfferingNotes(text: unknown): OfferingDraft[] {
    const s = typeof text === 'string' ? text.trim() : '';
    if (!s) return [];
    // One per line when they wrote a list; otherwise a sentence of comma / semicolon separated items.
    const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const pieces = lines.length > 1 ? lines : splitTopLevel(s, /[,;]/);
    const seen = new Set<string>();
    const out: OfferingDraft[] = [];
    for (const p of pieces) {
        const d = parseEntry(p);
        if (!d || seen.has(d.name.toLowerCase())) continue;
        seen.add(d.name.toLowerCase());
        out.push(d);
        if (out.length >= MAX_IMPORT_ITEMS) break;
    }
    return out;
}
