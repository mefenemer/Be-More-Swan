// src/utils/form-calculator.ts
// The formula language for calculator forms (FR#43 Phase 2, docs/claude-artifacts-review.md §6):
// "a price estimator / savings calculator" — the visitor answers, the SERVER works out a number from
// the business's formula, and shows it after they sign up.
//
// ── Why a hand-written parser ────────────────────────────────────────────────────────────────────
// A formula is written by a business (or drafted by the chat) and run on our server for strangers.
// It is NEVER eval'd or turned into a Function: it is parsed into a tiny tree of numbers, names,
// + − × ÷, brackets and a fixed list of functions, then walked. Nothing else exists in the language,
// so there is nothing else a formula can do. Size and depth are capped so a formula cannot be slow.
//
//   area * 45 + extras            names are the questions' saved-as keys
//   max(150, rooms * price(12))   price(<product id>) is a product's price from Products
//   round(budget * 0.2, 0)

export const MAX_FORMULA_LENGTH = 300;
const MAX_TOKENS = 120;
const MAX_DEPTH = 20;
/** Anything bigger is a mistake, not an estimate — and keeps formatting sane. */
const MAX_ABS = 1e12;

export const CALC_FUNCTIONS = ['min', 'max', 'round', 'ceil', 'floor', 'price'] as const;

export type CalcNode =
    | { k: 'num'; v: number }
    | { k: 'var'; name: string }
    | { k: 'neg'; a: CalcNode }
    | { k: 'bin'; op: '+' | '-' | '*' | '/'; a: CalcNode; b: CalcNode }
    | { k: 'fn'; name: typeof CALC_FUNCTIONS[number]; args: CalcNode[] }
    | { k: 'price'; id: number };

export type ParsedFormula =
    | { ok: true; tree: CalcNode; vars: string[]; products: number[] }
    | { ok: false; error: string };

type Tok = { t: 'num'; v: number } | { t: 'name'; v: string } | { t: 'op'; v: string };

function tokenise(src: string): Tok[] | string {
    const out: Tok[] = [];
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        if (/\s/.test(c)) { i++; continue; }
        if (/[0-9.]/.test(c)) {
            const m = /^(?:\d+(?:\.\d+)?|\.\d+)/.exec(src.slice(i));
            if (!m) return `"${c}" is not a number.`;
            out.push({ t: 'num', v: Number(m[0]) });
            i += m[0].length;
        } else if (/[a-z_]/i.test(c)) {
            const m = /^[a-z_][a-z0-9_]*/i.exec(src.slice(i))!;
            out.push({ t: 'name', v: m[0].toLowerCase() });
            i += m[0].length;
        } else if ('+-*/(),×÷'.includes(c)) {
            out.push({ t: 'op', v: c === '×' ? '*' : c === '÷' ? '/' : c });
            i++;
        } else {
            return `"${c}" can't be used in a formula — only numbers, names, + − × ÷, brackets and ${CALC_FUNCTIONS.join(', ')}.`;
        }
        if (out.length > MAX_TOKENS) return 'The formula is too long.';
    }
    return out;
}

/**
 * Parse a formula. `known` is the set of names it may use (the form's questions); anything else is
 * an error, said in plain words — the builder shows it under the formula box.
 */
export function parseFormula(src: string, known: Set<string>): ParsedFormula {
    const text = String(src ?? '').trim();
    if (!text) return { ok: false, error: 'Write a formula.' };
    if (text.length > MAX_FORMULA_LENGTH) return { ok: false, error: `A formula can be at most ${MAX_FORMULA_LENGTH} characters.` };
    const toks = tokenise(text);
    if (typeof toks === 'string') return { ok: false, error: toks };
    let p = 0;
    const vars = new Set<string>();
    const products = new Set<number>();
    const peek = () => toks[p];
    const isOp = (v: string) => peek()?.t === 'op' && peek()!.v === v;

    const expr = (depth: number): CalcNode => {
        if (depth > MAX_DEPTH) throw new Error('The formula has too many brackets inside each other.');
        let a = term(depth);
        while (isOp('+') || isOp('-')) { const op = (toks[p++] as { v: '+' | '-' }).v; a = { k: 'bin', op, a, b: term(depth) }; }
        return a;
    };
    const term = (depth: number): CalcNode => {
        let a = unary(depth);
        while (isOp('*') || isOp('/')) { const op = (toks[p++] as { v: '*' | '/' }).v; a = { k: 'bin', op, a, b: unary(depth) }; }
        return a;
    };
    const unary = (depth: number): CalcNode => {
        if (isOp('-')) { p++; return { k: 'neg', a: unary(depth + 1) }; }
        if (isOp('+')) { p++; return unary(depth + 1); }
        return primary(depth);
    };
    const primary = (depth: number): CalcNode => {
        const tk = toks[p++];
        if (!tk) throw new Error('The formula ends too early.');
        if (tk.t === 'num') return { k: 'num', v: tk.v };
        if (tk.t === 'op' && tk.v === '(') {
            const inner = expr(depth + 1);
            if (!isOp(')')) throw new Error('A bracket is not closed.');
            p++;
            return inner;
        }
        if (tk.t === 'name') {
            if (isOp('(')) {
                if (!(CALC_FUNCTIONS as readonly string[]).includes(tk.v)) throw new Error(`"${tk.v}" isn't a function. You can use ${CALC_FUNCTIONS.join(', ')}.`);
                p++;
                const args: CalcNode[] = [];
                if (!isOp(')')) {
                    args.push(expr(depth + 1));
                    while (isOp(',')) { p++; args.push(expr(depth + 1)); }
                }
                if (!isOp(')')) throw new Error(`${tk.v}( is not closed.`);
                p++;
                const name = tk.v as typeof CALC_FUNCTIONS[number];
                if (name === 'price') {
                    const a0 = args[0];
                    if (args.length !== 1 || a0?.k !== 'num' || !Number.isInteger(a0.v) || a0.v <= 0) throw new Error('price( needs one product number, like price(12).');
                    products.add(a0.v);
                    return { k: 'price', id: a0.v };
                }
                if ((name === 'min' || name === 'max') && args.length < 2) throw new Error(`${name}( needs at least two numbers.`);
                if ((name === 'ceil' || name === 'floor') && args.length !== 1) throw new Error(`${name}( needs one number.`);
                if (name === 'round' && (args.length < 1 || args.length > 2)) throw new Error('round( needs a number, and optionally how many decimal places.');
                return { k: 'fn', name, args };
            }
            if (!known.has(tk.v)) throw new Error(`"${tk.v}" isn't one of your questions. Use a question's saved-as name.`);
            vars.add(tk.v);
            return { k: 'var', name: tk.v };
        }
        throw new Error(`"${tk.v}" is in the wrong place.`);
    };

    try {
        const tree = expr(0);
        if (p < toks.length) throw new Error(`"${(toks[p] as { v: unknown }).v}" is in the wrong place.`);
        return { ok: true, tree, vars: [...vars], products: [...products] };
    } catch (e) {
        return { ok: false, error: (e as Error).message };
    }
}

/**
 * Work the formula out. `vars` holds each question's number (an unanswered one is 0); `price` gives a
 * product's price in pounds/dollars, or null when it has no fixed price. Null = no answer (dividing by
 * zero, a missing price, a silly number) — the visitor then gets the ordinary thank-you.
 */
export function evaluateFormula(tree: CalcNode, vars: Record<string, number>, price: (id: number) => number | null): number | null {
    const walk = (n: CalcNode): number => {
        switch (n.k) {
            case 'num': return n.v;
            case 'var': return Number.isFinite(vars[n.name]) ? vars[n.name] : 0;
            case 'neg': return -walk(n.a);
            case 'price': { const v = price(n.id); if (v == null || !Number.isFinite(v)) throw new Error('no price'); return v; }
            case 'bin': {
                const a = walk(n.a), b = walk(n.b);
                if (n.op === '/' && b === 0) throw new Error('divide by zero');
                return n.op === '+' ? a + b : n.op === '-' ? a - b : n.op === '*' ? a * b : a / b;
            }
            case 'fn': {
                const xs = n.args.map(walk);
                if (n.name === 'min') return Math.min(...xs);
                if (n.name === 'max') return Math.max(...xs);
                if (n.name === 'ceil') return Math.ceil(xs[0]);
                if (n.name === 'floor') return Math.floor(xs[0]);
                const dp = Math.max(0, Math.min(4, Math.round(xs[1] ?? 0)));
                return Math.round(xs[0] * 10 ** dp) / 10 ** dp;
            }
        }
    };
    try {
        const v = walk(tree);
        return Number.isFinite(v) && Math.abs(v) <= MAX_ABS ? v : null;
    } catch {
        return null;
    }
}

export const CALC_FORMATS = ['number', 'money', 'percent'] as const;
export const CALC_CURRENCIES = ['GBP', 'USD', 'EUR', 'AUD', 'CAD'] as const;
export const MAX_CALC_SPREAD = 50;

export interface CalcDisplay {
    format: typeof CALC_FORMATS[number];
    currency: typeof CALC_CURRENCIES[number];
    decimals: number;
    /** ± this many percent shows a range ("£1,140 – £1,260"); 0 shows one number. */
    spread: number;
    /** After the number: "per month", "kg of CO₂". */
    unit: string;
}

/** The number, rounded to the decimals the business chose — the value that is signed, stored and shown. */
export function roundCalc(n: number, decimals: number): number {
    const f = 10 ** decimals;
    return Math.round(n * f) / f;
}

function one(n: number, d: CalcDisplay): string {
    const opts = { minimumFractionDigits: d.decimals, maximumFractionDigits: d.decimals };
    if (d.format === 'money') return new Intl.NumberFormat('en-GB', { style: 'currency', currency: d.currency, ...opts }).format(n);
    const s = new Intl.NumberFormat('en-GB', opts).format(n);
    return d.format === 'percent' ? `${s}%` : s;
}

/** "£1,200", or "£1,140 – £1,260" with a spread, then the unit. */
export function formatCalc(n: number, d: CalcDisplay): string {
    const s = d.spread > 0
        ? `${one(roundCalc(n * (1 - d.spread / 100), d.decimals), d)} – ${one(roundCalc(n * (1 + d.spread / 100), d.decimals), d)}`
        : one(roundCalc(n, d.decimals), d);
    return d.unit ? `${s} ${d.unit}` : s;
}
