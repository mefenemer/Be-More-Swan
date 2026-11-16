// tests/form-calculator.test.ts
// Calculator forms (FR#43 Phase 2, docs/claude-artifacts-review.md §6): the visitor's answers go into
// the business's formula and the number is shown after they sign up.
//
// What would hurt:
//   1. A FORMULA THAT RUNS CODE — it is parsed into numbers, names, + − × ÷ and six functions; nothing
//      else exists, and it is never eval'd.
//   2. THE BROWSER DECIDING THE NUMBER — formula and amounts stay on the server; the public view has neither.
//   3. A NUMBER THAT ISN'T THE BUSINESS'S — another workspace's price; a /_sent link with a typed-in number.
//   4. A BROKEN FORMULA LOSING WORK OR SIGN-UPS — it's kept with a warning; the visitor still signs up.
//   5. AN ORDINARY FORM OR A QUIZ CHANGING.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateFormula, formatCalc, parseFormula } from '../src/utils/form-calculator';
import { calculatorProductIds, normaliseFormDefinition, publicCalcResult, publicDefinition, validateAnswers } from '../src/utils/form-definition';
import { formDraftFromUiElement } from '../src/utils/form-chat-draft';
import { sentLocation, signCalcValue, verifyCalcValue } from '../src/utils/site-forms';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const norm = (raw: unknown) => normaliseFormDefinition(raw);

// A kitchen-fitting estimate: area × a rate by finish, plus extras, at least the call-out product's price.
const CALC = {
    name: 'Kitchen estimate', purpose: 'calculator',
    fields: [
        { id: 'f_email', type: 'email', label: 'Email', required: true, target: { kind: 'contact', column: 'email' } },
        { id: 'f_area', type: 'number', label: 'Kitchen size (m²)', required: true, target: { kind: 'custom', key: 'area' }, range: { min: 1, max: 200 } },
        { id: 'f_finish', type: 'radio', label: 'Finish', required: true, target: { kind: 'custom', key: 'finish' },
          options: [{ value: 'std', label: 'Standard', amount: 400 }, { value: 'prem', label: 'Premium', amount: 650 }] },
        { id: 'f_extras', type: 'checkbox', label: 'Extras', required: false, target: { kind: 'custom', key: 'extras' },
          options: [{ value: 'isl', label: 'Island', amount: 1500 }, { value: 'app', label: 'Appliances', amount: 2000 }, { value: 'none', label: 'Just looking' }] },
    ],
    calculator: { formula: 'max(price(7), area * finish + extras)', label: 'Your estimate', format: 'money', currency: 'GBP', decimals: 0, spread: 10, unit: '',
                  body: 'A rough guide — we confirm after a visit.', ctaLabel: 'Book a visit', ctaUrl: 'https://example.com/visit' },
};
const KNOWN = new Set(['area', 'finish', 'extras']);
const tree = (src: string) => { const p = parseFormula(src, KNOWN); if (!p.ok) throw new Error(p.error); return p.tree; };
const ev = (src: string, vars: Record<string, number> = {}, prices: Record<number, number> = {}) => evaluateFormula(tree(src), vars, (id) => prices[id] ?? null);

// ── 1. The language is small and closed ─────────────────────────────────────

check('arithmetic, brackets, precedence, unary minus and the six functions work out right', () => {
    assert.strictEqual(ev('2 + 3 * 4'), 14);
    assert.strictEqual(ev('(2 + 3) * 4'), 20);
    assert.strictEqual(ev('-area + 10', { area: 4 }), 6);
    assert.strictEqual(ev('10 ÷ 4 × 2'), 5);
    assert.strictEqual(ev('min(3, 1, 2) + max(3, 9)'), 10);
    assert.strictEqual(ev('round(2.345, 2) + ceil(1.1) + floor(1.9)'), 2.35 + 2 + 1);
    assert.strictEqual(ev('price(7) * 2', {}, { 7: 49.5 }), 99);
});

check('nothing but the language parses — no code, no unknown names, no runaway formulas', () => {
    for (const bad of [
        'process.exit(1)', 'constructor', 'area; 1', 'require("fs")', '`x`', 'area ** 2', 'alert(1)',
        'nope * 2', 'price(area)', 'price(1, 2)', 'max(1)', '(1 + 2', '1 +', '', 'x'.repeat(400),
        '('.repeat(30) + '1' + ')'.repeat(30),
    ]) {
        assert.strictEqual(parseFormula(bad, KNOWN).ok, false, `"${bad.slice(0, 40)}" must not parse`);
    }
    const src = read('src/utils/form-calculator.ts');
    assert.ok(!/\beval\(|new Function|Function\(/.test(src.replace(/\/\/.*$/gm, '')), 'the engine never evaluates code');
});

check('dividing by zero, a missing price or a silly number gives no answer rather than a wrong one', () => {
    assert.strictEqual(ev('10 / (area - 4)', { area: 4 }), null);
    assert.strictEqual(ev('price(9) + 1'), null);
    assert.strictEqual(ev('area * area * area * area', { area: 1e6 }), null);
});

// ── 2. Formula and amounts stay on the server ──────────────────────────────

check('a stranger sees the questions and limits, never the formula or what each choice is worth', () => {
    const { definition: d } = norm(CALC);
    const pub = publicDefinition(d, { logoUrl: null, senderName: 'Kitchens' });
    const text = JSON.stringify(pub);
    for (const leak of ['formula', 'price(7)', 'amount', '650', 'A rough guide']) assert.ok(!text.includes(leak), `"${leak}" must not reach the browser`);
    assert.strictEqual(pub.calculator, true);
    assert.deepStrictEqual((pub.fields[1] as { range?: unknown }).range, { min: 1, max: 200 });
});

check('the number is worked out from the STORED definition and the workspace\'s prices', () => {
    const { definition: d } = norm(CALC);
    // 10 m² × Premium 650 + Island 1500 = 8000; the call-out price only matters when it is higher.
    const r = validateAnswers(d, { f_email: 'a@b.co', f_area: '10', f_finish: 'prem', f_extras: ['isl'], calc: 1 }, { prices: { 7: 250 } });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.strictEqual(r.answers.calcAmount, 8000);
    assert.strictEqual(r.answers.stored.calc_value, '8000');
    const small = validateAnswers(d, { f_email: 'a@b.co', f_area: '1', f_finish: 'std' }, { prices: { 7: 900 } });
    assert.ok(small.ok && small.answers.calcAmount === 900, 'max(price(7), …) — the minimum charge');
    assert.deepStrictEqual(calculatorProductIds(d), [7]);
});

check('a number answer must be a number within the limits; commas are fine', () => {
    const { definition: d } = norm(CALC);
    const bad = validateAnswers(d, { f_email: 'a@b.co', f_area: 'lots', f_finish: 'std' });
    assert.ok(!bad.ok && bad.error.includes('needs a number'));
    const big = validateAnswers(d, { f_email: 'a@b.co', f_area: '1,000', f_finish: 'std' });
    assert.ok(!big.ok && big.error.includes('at most 200'));
    const ok = validateAnswers(d, { f_email: 'a@b.co', f_area: ' 15 ', f_finish: 'std' }, { prices: { 7: 0 } });
    assert.ok(ok.ok && ok.answers.calcAmount === 6000);
});

check('the visitor is shown the label, a formatted range and the business\'s words — and the reply carries it', () => {
    const { definition: d } = norm(CALC);
    const shown = publicCalcResult(d.calculator!, 8000);
    assert.strictEqual(shown.value, '£7,200 – £8,800');
    assert.strictEqual(shown.ctaUrl, 'https://example.com/visit');
    assert.ok(!('formula' in shown));
    assert.strictEqual(formatCalc(12.5, { format: 'percent', currency: 'GBP', decimals: 1, spread: 0, unit: 'saving' }), '12.5% saving');
    const src = read('netlify/functions/audience-public.ts');
    assert.ok(src.includes('publicCalcResult(def.calculator, answers.calcAmount)'), 'the subscribe reply uses publicCalcResult');
    assert.ok(src.indexOf('publicCalcResult(def.calculator') < src.indexOf("existing.status === 'bounced'"), 'set before the silent-success branches');
    assert.ok(/loadCalculatorPrices\(db, form\.organisationId,/.test(src), 'prices are read for the FORM\'s own workspace');
});

// ── 3. Only the business's own numbers ─────────────────────────────────────

check('prices come only from the form\'s own workspace, and only fixed or "from" prices of active products', () => {
    const src = read('src/utils/calculator-prices.ts');
    assert.ok(src.includes('eq(orgProducts.organisationId, organisationId)'));
    assert.ok(src.includes("r.status !== 'active'") && src.includes("r.priceType !== 'fixed' && r.priceType !== 'from'"));
});

check('the website thank-you shows a number only when its signature verifies', () => {
    const key = 'test-secret';
    const sig = signCalcValue(12, '8000', key)!;
    assert.ok(verifyCalcValue(12, '8000', sig, key));
    assert.ok(!verifyCalcValue(12, '1', sig, key), 'a typed-in number fails');
    assert.ok(!verifyCalcValue(13, '8000', sig, key), 'another form\'s number fails');
    assert.ok(!verifyCalcValue(12, '8000', sig, ''), 'no secret, no number');
    assert.strictEqual(sentLocation('signup', 's1', '/', 'calc', { v: '8000', sig: 'abc' }), '/_sent?k=signup&s=s1&b=%2F&r=calc&v=8000&vs=abc');
    const sf = read('src/utils/site-forms.ts');
    assert.ok(sf.includes("verifyCalcValue(formId, v, q.get('vs') || '')"), '/_sent checks the signature');
});

// ── 4. A broken formula loses nothing ──────────────────────────────────────

check('a formula that doesn\'t work is KEPT with a warning, and the visitor still signs up with no number', () => {
    const { definition: d, warnings } = norm({ ...CALC, calculator: { ...CALC.calculator, formula: 'area * rate' } });
    assert.strictEqual(d.calculator!.formula, 'area * rate');
    assert.ok(warnings.some((w) => w.includes('"rate" isn\'t one of your questions')));
    const r = validateAnswers(d, { f_email: 'a@b.co', f_area: '10', f_finish: 'std' });
    assert.ok(r.ok && r.answers.calcAmount === null && !('calc_value' in r.answers.stored));
});

check('the chat card keeps a drafted calculator, and the Email Marketing chat knows how to draft one', () => {
    const draft = formDraftFromUiElement({ type: 'audience_form_draft', form: CALC });
    assert.ok(draft);
    assert.strictEqual(draft!.form.calculator!.formula, CALC.calculator.formula);
    assert.strictEqual(draft!.form.fields[2].options[1].amount, 650);
    assert.ok(read('netlify/functions/chat-orchestrator.ts').includes('CALCULATORS — a form can be a CALCULATOR'));
});

check('the builder has a Calculator tab with the formula, each choice\'s amount and a Number question', () => {
    const b = read('src/components/form-builder.js');
    assert.ok(b.includes("['calc', 'Calculator']"));
    assert.ok(b.includes('data-fb-amount'));
    assert.ok(b.includes('data-fb-calc="formula"'));
    assert.ok(b.includes("key: 'number', label: 'Number'"));
});

// ── 5. Ordinary forms and quizzes are unchanged ────────────────────────────

check('a form with no calculator has no number; a quiz wins over a calculator', () => {
    const { definition: plain } = norm({ fields: CALC.fields.slice(0, 2) });
    assert.strictEqual(plain.calculator, null);
    const r = validateAnswers(plain, { f_email: 'a@b.co', f_area: '5' });
    assert.ok(r.ok && r.answers.calcAmount === null);
    const both = norm({ ...CALC, quiz: { results: [{ title: 'A' }, { title: 'B' }] } });
    assert.strictEqual(both.definition.calculator, null);
    assert.ok(both.definition.quiz);
    assert.ok(both.warnings.some((w) => w.includes('quiz or a calculator')));
    assert.ok(both.definition.fields[2].options.every((o) => !('amount' in o)), 'no amounts survive without a calculator');
});

console.log(`\n${passed} checks passed.`);
