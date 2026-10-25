// src/utils/break-even.ts
// The break-even calculator (docs/business-mentor-plan.md §4.3): "If I spend £500 on ads, how many sales
// do I need?" Worked out HERE, in code, never by the model. Pure.
//
// One function for both ways in: the Plan tab's calculator (mentor.ts action 'break_even') and the chat's
// mentor_break_even card, whose result the server fills from this before the card is drawn. The model
// only picks the inputs (from what the user said or the business plan) and explains the answer.
//
// Every input is shown with where it came from. An input the user didn't give is an ASSUMPTION, and
// says so; a conversion rate may carry the link of a research result that found it.

export const BREAK_EVEN_INPUTS = {
    price: { label: 'Price of one sale', unit: '£', min: 0.01, max: 1_000_000 },
    costPerSale: { label: 'Cost of making or delivering one sale', unit: '£', min: 0, max: 1_000_000 },
    fixedCosts: { label: 'Fixed costs for the period', unit: '£', min: 0, max: 100_000_000 },
    spend: { label: 'Marketing spend (e.g. ads)', unit: '£', min: 0, max: 100_000_000 },
    conversionRate: { label: 'Leads that become a sale', unit: '%', min: 0.01, max: 100 },
} as const;
export type BreakEvenKey = keyof typeof BREAK_EVEN_INPUTS;
export const BREAK_EVEN_KEYS = Object.keys(BREAK_EVEN_INPUTS) as BreakEvenKey[];

export type InputSource = 'you' | 'plan' | 'assumption';
export interface BreakEvenInput { value: number; source: InputSource; note?: string; sourceUrl?: string }
export type BreakEvenInputs = Partial<Record<BreakEvenKey, BreakEvenInput>>;

export interface BreakEvenResult {
    ok: true;
    inputs: Record<BreakEvenKey, BreakEvenInput | null>;
    /** Price minus cost per sale: what each sale contributes. */
    marginPerSale: number;
    /** Sales needed to cover the spend alone. */
    salesToCoverSpend: number;
    /** Sales needed to cover fixed costs and spend: the break-even point. */
    salesToBreakEven: number;
    /** Leads needed for those sales, at the conversion rate; null without one. */
    leadsToCoverSpend: number | null;
    leadsToBreakEven: number | null;
    /** Inputs that are assumptions, by label, for the "assumed" line. */
    assumed: string[];
    /** One plain sentence, written by code, that the chat appends so the model never states the figure itself. */
    sentence: string;
}
export type BreakEvenOutcome = BreakEvenResult | { ok: false; error: string };

const money = (n: number) => `£${n.toLocaleString('en-GB', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
const whole = (n: number) => n.toLocaleString('en-GB');

/** Pure: one input as sent by the page or the model, or null. Accepts "£1,200", "12%" and numbers. */
export function readInput(key: BreakEvenKey, raw: unknown): BreakEvenInput | null {
    if (raw === null || raw === undefined || raw === '') return null;
    const o = typeof raw === 'object' ? raw as Record<string, unknown> : { value: raw };
    const n = typeof o.value === 'number' ? o.value : Number(String(o.value ?? '').replace(/[£,%\s]/g, ''));
    if (!Number.isFinite(n)) return null;
    const def = BREAK_EVEN_INPUTS[key];
    if (n < def.min || n > def.max) return null;
    const source: InputSource = o.source === 'plan' || o.source === 'assumption' ? o.source : 'you';
    const note = typeof o.note === 'string' && o.note.trim() ? o.note.trim().slice(0, 200) : undefined;
    const sourceUrl = typeof o.sourceUrl === 'string' && /^https?:\/\/\S+$/i.test(o.sourceUrl) ? o.sourceUrl.slice(0, 500) : undefined;
    return { value: Math.round(n * 100) / 100, source, ...(note ? { note } : {}), ...(sourceUrl ? { sourceUrl } : {}) };
}

/** Pure: the calculation. Price and at least one of fixed costs / spend are required; conversion is optional. */
export function breakEven(raw: Record<string, unknown> | null | undefined): BreakEvenOutcome {
    const r = raw && typeof raw === 'object' ? raw : {};
    const inputs = Object.fromEntries(BREAK_EVEN_KEYS.map((k) => [k, readInput(k, r[k])])) as Record<BreakEvenKey, BreakEvenInput | null>;
    // A guessed £0 of fixed costs or spend changes nothing, so it isn't reported as an assumption
    // (live on staging the model filled "fixed costs: £0, assumption" and the card said it had assumed them).
    for (const k of ['fixedCosts', 'spend'] as const) if (inputs[k]?.value === 0 && inputs[k]?.source === 'assumption') inputs[k] = null;
    if (!inputs.price) return { ok: false, error: 'Enter the price of one sale.' };
    const cost = inputs.costPerSale?.value ?? 0;
    const margin = Math.round((inputs.price.value - cost) * 100) / 100;
    if (margin <= 0) return { ok: false, error: 'Each sale costs as much as it brings in or more, so no number of sales breaks even. Check the price and the cost per sale.' };
    const fixed = inputs.fixedCosts?.value ?? 0;
    const spend = inputs.spend?.value ?? 0;
    if (!fixed && !spend) return { ok: false, error: 'Enter the fixed costs or the marketing spend to cover.' };

    const salesToCoverSpend = spend ? Math.ceil(spend / margin) : 0;
    const salesToBreakEven = Math.ceil((fixed + spend) / margin);
    const rate = inputs.conversionRate ? inputs.conversionRate.value / 100 : null;
    const leads = (sales: number) => (rate ? Math.ceil(sales / rate) : null);
    const assumed = BREAK_EVEN_KEYS.filter((k) => inputs[k]?.source === 'assumption').map((k) => BREAK_EVEN_INPUTS[k].label.toLowerCase());

    const covering = [fixed ? `${money(fixed)} of fixed costs` : '', spend ? `${money(spend)} of marketing` : ''].filter(Boolean).join(' and ');
    const leadText = rate ? ` — about ${whole(leads(salesToBreakEven)!)} leads if ${inputs.conversionRate!.value}% of leads buy` : '';
    const sentence = `Worked out in code: each sale brings in ${money(margin)} after its own cost, so covering ${covering} takes ${whole(salesToBreakEven)} sale${salesToBreakEven === 1 ? '' : 's'}${leadText}.`
        + (assumed.length ? ` Assumed, not from you: ${assumed.join(', ')}.` : '');

    return {
        ok: true, inputs, marginPerSale: margin, salesToCoverSpend, salesToBreakEven,
        leadsToCoverSpend: leads(salesToCoverSpend), leadsToBreakEven: leads(salesToBreakEven), assumed, sentence,
    };
}
