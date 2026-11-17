// tests/feature-review.test.ts — "Review with AI" on admin feature requests (owner 2026-11-17).
// Opus 5.5 reviews against fixed headings; the admin ticks which suggestions to add; nothing auto-saves.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    FEATURE_REVIEW_MODEL, REVIEW_AREAS, MAX_SUGGESTIONS_PER_AREA,
    buildReviewPrompt, parseReview, appendSuggestions,
} from '../src/utils/feature-review';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'admin.html'), 'utf8');
const fn = readFileSync(join(root, 'netlify/functions/admin-feature-requests.ts'), 'utf8');
const toml = readFileSync(join(root, 'netlify.toml'), 'utf8');
let passed = 0;
function check(name: string, f: () => void) {
    try { f(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const fnBody = (src: string, sig: string) => { const i = src.indexOf(sig); assert.ok(i > 0, sig); return src.slice(i, src.indexOf('\n}', i)); };
console.log('feature-review');

check('the review uses Opus 5.5', () => assert.strictEqual(FEATURE_REVIEW_MODEL, 'claude-opus-5-5'));

check("the owner's headings are all in the fixed list, in order", () => {
    const keys = REVIEW_AREAS.map(a => a.key);
    const owner = ['ux', 'ui', 'performance', 'disruptive', 'value', 'will_pay', 'uniqueness', 'connections', 'gui_chat'];
    assert.deepStrictEqual(keys.slice(0, owner.length), owner);
    assert.ok(keys.length > owner.length, 'Claude adds its own headings after the owner\'s');
});

check('the prompt names every heading and carries the request', () => {
    const p = buildReviewPrompt({ title: 'Bulk CSV', description: 'Upload posts', brief: '' });
    for (const a of REVIEW_AREAS) assert.ok(p.includes(`- ${a.key}:`), a.key);
    assert.ok(p.includes('"""Bulk CSV"""') && p.includes('"""Upload posts"""') && p.includes('(none yet)'));
});

check('parse: every heading comes back in order, unknown keys dropped, caps applied', () => {
    const raw = 'Here you go:\n```json\n' + JSON.stringify({
        summary: 'Decent.',
        areas: [
            { key: 'value', verdict: 'Clear.', suggestions: [] },
            { key: 'ux', verdict: 'Thin.', suggestions: [
                { title: 'A', detail: 'a', target: 'brief' }, { title: 'B', detail: 'b' }, { title: 'C', detail: 'c' },
            ] },
            { key: 'made_up', verdict: 'x', suggestions: [{ title: 'Z', detail: 'z' }] },
            { key: 'ui', verdict: 'Ok', suggestions: [{ title: '', detail: 'no title' }] },
        ],
    }) + '\n```';
    const r = parseReview(raw);
    assert.strictEqual(r.summary, 'Decent.');
    assert.deepStrictEqual(r.areas.map(a => a.key), REVIEW_AREAS.map(a => a.key));
    assert.strictEqual(r.areas.find(a => a.key === 'performance')!.verdict, 'Not reviewed.');
    assert.strictEqual(r.suggestions.length, MAX_SUGGESTIONS_PER_AREA);
    assert.deepStrictEqual(r.suggestions.map(s => [s.area, s.title, s.target]), [['ux', 'A', 'brief'], ['ux', 'B', 'description']]);
});

check('parse refuses a reply with no JSON', () => assert.throws(() => parseReview('Sorry, I cannot.')));

check('append: only picked items, grouped label, existing text kept; none picked = unchanged', () => {
    assert.strictEqual(appendSuggestions('Keep me', []), 'Keep me');
    const out = appendSuggestions('Keep me\n', [{ area: 'will_pay', title: 'Plan', detail: 'Put it on £79.' }]);
    assert.strictEqual(out, 'Keep me\n\nImprovements (AI review):\n- [Will people pay] Plan: Put it on £79.');
});

check('server: review action calls the review model, logs cost, returns suggestions without saving', () => {
    const i = fn.indexOf("action === 'review'");
    const block = fn.slice(i, fn.indexOf('// ── POST ?action=merge', i));
    assert.ok(i > 0 && block.includes('model: FEATURE_REVIEW_MODEL') && block.includes('logAiUsage(') && block.includes('parseReview('));
    assert.ok(block.includes('isGlobalAiDisabled()'), 'respects the AI kill switch');
    assert.ok(!/db\.(update|insert)/.test(block), 'review never writes the request');
    assert.ok(/\[functions\.admin-feature-requests\]\s*\n\s*timeout = 26/.test(toml), 'Opus needs the 26 s limit');
});

check('page: Review button, unticked boxes, Add selected appends only ticked ones, no auto-save', () => {
    const form = html.slice(html.indexOf('<div id="fr-form"'), html.indexOf('<!-- Board pane'));
    assert.ok(/id="fr-review-btn"[^>]*onclick="frReviewRequest\(\)"/.test(form));
    assert.ok(/id="fr-review-apply"[^>]*onclick="frApplyReview\(\)"/.test(form));
    const review = fnBody(html, 'async function frReviewRequest()');
    assert.ok(review.includes('?action=review') && review.includes('data-fr-review-pick="${i}">'), 'boxes start unticked');
    const apply = fnBody(html, 'function frApplyReview()');
    assert.ok(apply.includes('.filter(cb => cb.checked)'));
    assert.ok(!apply.includes('api(') && !apply.includes('submitRoadmapForm'), 'admin still presses Save');
});

check('page: the review panel resets when the form opens for add or edit', () => {
    for (const sig of ['function openRoadmapAdd()', 'function openRoadmapEdit(id)']) assert.ok(fnBody(html, sig).includes('_frResetReview();'), sig);
});

console.log(`\n${passed} passed`);
