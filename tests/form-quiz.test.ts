// tests/form-quiz.test.ts
// Quiz forms (FR#43, docs/claude-artifacts-review.md): a sign-up form whose choice questions score
// towards one of 2–5 results the business wrote. The result is shown instead of the thank-you and
// tags the contact.
//
// What would hurt:
//   1. THE BROWSER DECIDING THE RESULT — points must stay on the server; the public view never has them.
//   2. A RESULT THAT ISN'T THE BUSINESS'S — an unknown result id, a javascript: link, a ?r= that
//      shows something the form never stored.
//   3. A QUIZ THAT GIVES NO ANSWER — ties and "no points" must still pick a result.
//   4. THE RESULT NOT REACHING THE CONTACT — its tag must go where every form tag goes.
//   5. AN ORDINARY FORM CHANGING — no quiz, no result, nothing new in the reply.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normaliseFormDefinition, publicDefinition, quizResultFor, validateAnswers, MAX_QUIZ_RESULTS } from '../src/utils/form-definition';
import { formDraftFromUiElement } from '../src/utils/form-chat-draft';
import { sentLocation } from '../src/utils/site-forms';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const norm = (raw: unknown) => normaliseFormDefinition(raw);

const QUIZ = {
    name: 'Which facial?', purpose: 'quiz',
    fields: [
        { id: 'f_email', type: 'email', label: 'Email', required: true, target: { kind: 'contact', column: 'email' } },
        { id: 'f_skin', type: 'radio', label: 'Your skin', required: true, target: { kind: 'custom', key: 'skin' },
          options: [{ value: 'oily', label: 'Oily', scores: { r_deep: 1 } }, { value: 'dry', label: 'Dry', scores: { r_hydra: 1 } }, { value: 'fine', label: 'Fine' }] },
        { id: 'f_goal', type: 'select', label: 'Your goal', required: false, target: { kind: 'custom', key: 'goal' },
          options: [{ value: 'clear', label: 'Clearer skin', scores: { r_deep: 2 } }, { value: 'glow', label: 'A glow', scores: { r_hydra: 1 } }] },
    ],
    quiz: { results: [
        { id: 'r_deep', title: 'The deep-clean facial', body: 'Made for oily skin.', tag: 'facial-deep', ctaLabel: 'Book it', ctaUrl: 'https://example.com/book' },
        { id: 'r_hydra', title: 'The hydrating facial', body: 'Made for dry skin.' },
    ] },
};

// ── 1. Points stay on the server ────────────────────────────────────────────

check('a stranger sees the choices, never what they score, and no results', () => {
    const { definition: d } = norm(QUIZ);
    const pub = publicDefinition(d, { logoUrl: null, senderName: 'Spa' });
    const text = JSON.stringify(pub);
    for (const leak of ['scores', 'r_deep', 'facial-deep', 'Made for oily skin']) assert.ok(!text.includes(leak), `"${leak}" must not reach the browser`);
    assert.strictEqual(pub.quiz, true);
    assert.deepStrictEqual(pub.fields[1].options[0], { value: 'oily', label: 'Oily' });
});

check('the result is worked out from the STORED definition, whatever the browser sends', () => {
    const { definition: d } = norm(QUIZ);
    // A browser claiming a result, or sending an option that does not exist, changes nothing.
    const r = validateAnswers(d, { f_email: 'a@b.co', f_skin: 'dry', f_goal: 'glow', quiz_result: 'r_deep', f_x: 'r_deep' });
    assert.ok(r.ok);
    assert.strictEqual(r.ok && r.answers.quizResult?.id, 'r_hydra');
});

// ── 2. Only the business's own results ──────────────────────────────────────

check('points towards a result that does not exist are dropped; points are whole and capped', () => {
    const { definition: d } = norm({ ...QUIZ, fields: [QUIZ.fields[0], { ...QUIZ.fields[1], options: [
        { value: 'a', label: 'A', scores: { r_nope: 5, r_deep: 99 } }, { value: 'b', label: 'B', scores: { r_hydra: -3 } }] }] });
    const opts = d.fields[1].options;
    assert.deepStrictEqual(opts[0].scores, { r_deep: 10 });
    assert.strictEqual(opts[1].scores, undefined);
});

check('a result link must be http(s); without one there is no button', () => {
    const { definition: d, warnings } = norm({ ...QUIZ, quiz: { results: [{ ...QUIZ.quiz.results[0], ctaUrl: 'javascript:alert(1)' }, QUIZ.quiz.results[1]] } });
    assert.strictEqual(d.quiz!.results[0].ctaUrl, null);
    assert.strictEqual(d.quiz!.results[0].ctaLabel, '');
    assert.ok(warnings.some((w) => w.includes('http(s)')));
});

check('fewer than two results is an ordinary form; more than five are cut to five', () => {
    const one = norm({ ...QUIZ, quiz: { results: [QUIZ.quiz.results[0]] } });
    assert.strictEqual(one.definition.quiz, null);
    assert.ok(one.warnings.some((w) => w.includes('at least 2 results')));
    assert.ok(one.definition.fields[1].options.every((o) => !o.scores), 'no points survive without a quiz');
    const many = norm({ ...QUIZ, quiz: { results: Array.from({ length: 8 }, (_, i) => ({ title: `R${i}` })) } });
    assert.strictEqual(many.definition.quiz!.results.length, MAX_QUIZ_RESULTS);
});

check('the website thank-you page is told only a result id, and reads the words from the stored form', () => {
    assert.strictEqual(sentLocation('signup', 's1', '/', 'r_deep'), '/_sent?k=signup&s=s1&b=%2F&r=r_deep');
    assert.strictEqual(sentLocation('signup', 's1', '/'), '/_sent?k=signup&s=s1&b=%2F');
    const src = read('src/utils/site-forms.ts');
    assert.ok(src.includes("form?.def.quiz?.results.find((x) => x.id === rid)"), '/_sent picks one of the form\'s own results by id');
    assert.ok(/link && \/\^https\?:/.test(read('src/utils/site-render.ts')), 'the notice draws only an http(s) link');
});

// ── 3. A quiz always answers ────────────────────────────────────────────────

check('most points wins; a tie and "no points" go to the result listed first', () => {
    const { definition: d } = norm(QUIZ);
    assert.strictEqual(quizResultFor(d, { f_skin: ['oily'], f_goal: ['glow'] })!.id, 'r_deep');   // 1 v 1 → first
    assert.strictEqual(quizResultFor(d, { f_skin: ['dry'], f_goal: ['clear'] })!.id, 'r_deep');   // 1 v 2
    assert.strictEqual(quizResultFor(d, { f_skin: ['dry'], f_goal: ['glow'] })!.id, 'r_hydra');   // 0 v 2
    assert.strictEqual(quizResultFor(d, { f_skin: ['fine'] })!.id, 'r_deep');                     // nothing scored
});

// ── 4. The result reaches the contact ───────────────────────────────────────

check('the result\'s tag joins the form\'s tags, and its id is kept with the submission', () => {
    const { definition: d } = norm({ ...QUIZ, audience: { tags: ['quiz'] } });
    const r = validateAnswers(d, { f_email: 'a@b.co', f_skin: 'oily' });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepStrictEqual(r.answers.tags, ['quiz', 'facial-deep']);
    assert.strictEqual(r.answers.stored.quiz_result, 'r_deep');
    // No tag written → the title is the tag.
    const h = validateAnswers(d, { f_email: 'a@b.co', f_skin: 'dry' });
    assert.ok(h.ok && h.answers.tags.includes('The hydrating facial'));
});

check('the subscribe reply carries the result to the visitor — words only, and on every success after the check', () => {
    const src = read('netlify/functions/audience-public.ts');
    const at = src.indexOf('const quizResult = answers.quizResult ? publicQuizResult(answers.quizResult) : null;');
    assert.ok(at > 0, 'the reply is built from publicQuizResult (no tag)');
    assert.ok(at < src.indexOf("existing.status === 'bounced'"), 'set before the silent-success branches, so they look the same');
    const pub = read('src/utils/form-definition.ts');
    assert.ok(/export function publicQuizResult[\s\S]{0,200}id: x\.id, title: x\.title, body: x\.body, ctaLabel: x\.ctaLabel, ctaUrl: x\.ctaUrl/.test(pub));
});

check('the embed draws the result escaped, and its link only when it is http(s)', () => {
    const js = read('subscribe.js');
    assert.ok(js.includes("showResult(out.data.result);"));
    assert.ok(js.includes("'<p class=\"bms-rt\">' + esc(r.title) + '</p>'"));
    assert.ok(/\/\^https\?:\\\/\\\/\/i\.test\(r\.ctaUrl\)/.test(js));
});

check('the chat card keeps a drafted quiz (results and points) through the one gate', () => {
    const draft = formDraftFromUiElement({ type: 'audience_form_draft', form: QUIZ });
    assert.ok(draft);
    assert.strictEqual(draft!.form.quiz!.results.length, 2);
    assert.deepStrictEqual(draft!.form.fields[1].options[0].scores, { r_deep: 1 });
    const prompt = read('netlify/functions/chat-orchestrator.ts');
    assert.ok(prompt.includes('QUIZZES — a form can be a QUIZ'), 'the Email Marketing chat knows how to draft one');
});

check('the builder has a Quiz tab that sets which result each answer points to', () => {
    const b = read('src/components/form-builder.js');
    assert.ok(b.includes("['quiz', 'Quiz']"));
    assert.ok(b.includes('data-fb-points'));
    assert.ok(b.includes('if (t.value) o.scores = { [t.value]: 1 }; else delete o.scores;'));
});

// ── 5. Ordinary forms are untouched ─────────────────────────────────────────

check('a form without a quiz has no result and no extra tag', () => {
    const { definition: d } = norm({ fields: QUIZ.fields.map((f) => ({ ...f, options: (f.options || []).map(({ value, label }) => ({ value, label })) })) });
    assert.strictEqual(d.quiz, null);
    const r = validateAnswers(d, { f_email: 'a@b.co', f_skin: 'oily' });
    assert.ok(r.ok && r.answers.quizResult === null && !('quiz_result' in r.answers.stored) && r.answers.tags.length === 0);
});

console.log(`\n${passed} checks passed.`);
