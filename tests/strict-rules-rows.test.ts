// tests/strict-rules-rows.test.ts
// Strict Rules on the assistant profile are entered one row per rule with an "Add Rule" button,
// the same way Assistant Rules are — not a textarea that asked the user to start every line with a
// dash (2026-10-09). Storage is unchanged: configuration.inputs.strictRules, one
// "- NON-NEGOTIABLE: …" entry per rule, the form onboarding writes and the blueprint reads.
//
// Run:  npx tsx tests/strict-rules-rows.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractOnboardingGuardrails } from '../src/utils/onboarding-guardrails';

let passed = 0;
function check(name: string, fn: () => void): void {
    try {
        fn();
        passed++; console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1;
    }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
function slice(text: string, start: string, end: string): string {
    const i = text.indexOf(start);
    assert.ok(i >= 0, `marker not found: ${start}`);
    assert.strictEqual(text.indexOf(start, i + 1), -1, `marker not unique: ${start}`);
    const j = text.indexOf(end, i + start.length);
    assert.ok(j > i, `end marker not found after ${start}`);
    return text.slice(i, j);
}

const html = read('assistant-detail.html');
const js = read('assistants.js');

console.log('\nStrict Rules: entered row by row');
check('the textarea and its "start each rule with a dash" instruction are gone', () => {
    assert.ok(!html.includes('id="edit_strict_rules"'), 'the old textarea is still there');
    assert.ok(!/Start each rule with a dash/i.test(html), 'the dash instruction is still shown');
    assert.ok(!js.includes("getElementById('edit_strict_rules')"), 'code still reads the removed textarea');
});
check('an "Add Rule" button and a row list sit in the Strict Rules card', () => {
    const card = slice(html, '<h3 class="text-lg font-bold text-gray-900">Strict Rules</h3>', '<!-- Per-assistant Assistant Rules');
    assert.ok(card.includes('id="btn-add-strict-rule"') && />\s*Add Rule\s*</.test(card.replace(/<svg[\s\S]*?<\/svg>/g, '')));
    assert.ok(card.includes('id="strict-rules-list"'));
    assert.ok(card.includes('btn-primary'), 'button not styled like the Assistant Rules "Add Rule"');
});
check('the button and rows are bound on the document, not from the render path', () => {
    const helpers = slice(js, "const STRICT_RULE_PREFIX = '- NON-NEGOTIABLE: ';", 'function _detailCollect(currentData) {');
    assert.ok(/document\.addEventListener\('click'[\s\S]*#btn-add-strict-rule/.test(helpers));
    assert.ok(/document\.addEventListener\('input'[\s\S]*\.sr-input[\s\S]*_strictRulesChanged/.test(helpers));
    assert.ok(js.includes('window._strictRulesChanged = triggerAutoSave;'), 'edits never reach the profile autosave');
});

// Exercise the real helpers out of assistants.js against a tiny DOM stand-in.
const helperSrc = slice(js, "const STRICT_RULE_PREFIX = '- NON-NEGOTIABLE: ';", '\nfunction _buildStrictRuleRow(');
const collectSrc = slice(js, 'function _collectStrictRules() {', '\n// Bound once on the document');
function collect(values: string[]): string[] {
    const doc = { querySelectorAll: () => values.map((value) => ({ value })) };
    // eslint-disable-next-line no-new-func
    return new Function('document', `${helperSrc}\n${collectSrc}\nreturn _collectStrictRules();`)(doc);
}
// eslint-disable-next-line no-new-func
const textOf = new Function(`${helperSrc}\nreturn _strictRuleText;`)() as (s: string) => string;

check('stored rules display without the dash or the machine prefix', () => {
    assert.strictEqual(textOf('- ALWAYS use British English'), 'ALWAYS use British English');
    assert.strictEqual(textOf('- NON-NEGOTIABLE: Never mention competitors'), 'Never mention competitors');
    assert.strictEqual(textOf('Plain rule typed without a dash'), 'Plain rule typed without a dash');
    assert.strictEqual(textOf('*Never* swear'), '*Never* swear', 'markdown emphasis eaten as a bullet');
});
check('each row saves as ONE entry in the onboarding format; blanks are dropped', () => {
    assert.deepStrictEqual(collect(['Always use British English', '   ', '- Never mention competitors']),
        ['- NON-NEGOTIABLE: Always use British English', '- NON-NEGOTIABLE: Never mention competitors']);
});
check('a row with a line break stays one rule', () => {
    assert.deepStrictEqual(collect(['Never promise\nprices']), ['- NON-NEGOTIABLE: Never promise prices']);
});
check('what is saved is what onboarding would have saved — the guardrail extractor reads it back', () => {
    const saved = collect(['Always use British English', 'Never mention competitors']);
    assert.deepStrictEqual(extractOnboardingGuardrails(saved), ['Always use British English', 'Never mention competitors']);
});
check('a pre-change save holding several lines in one entry is split into rows', () => {
    const render = slice(js, 'function _renderStrictRules(stored) {', 'function _collectStrictRules() {');
    assert.ok(/split\('\\n'\)/.test(render), 'multi-line legacy entries render as one row');
});
check('the knowledge-base line stays out of the rows and is still saved', () => {
    assert.ok(js.includes("allStrict.filter(r => !r.includes('KNOWLEDGE BASE (TEXT)'))"));
    assert.ok(js.includes('if (knowledge) strictLines.push(`- KNOWLEDGE BASE (TEXT):'));
});

console.log(`\n${passed} checks passed${process.exitCode ? ' — with FAILURES above' : ''}`);
