// tests/form-definition.test.ts
// The sign-up form definition (src/utils/form-definition.ts) — one shape for the chat, the form
// builder and the renderer, and the one gate every definition passes through.
//
// What would hurt:
//   1. CSS INJECTION ON A CUSTOMER'S WEBSITE — a style value that is not a token.
//   2. A FORM THAT COLLECTS NOTHING — no email, or a question with nowhere to save its answer.
//   3. THE BROWSER DECIDING WHAT IS VALID — required questions, options, unknown fields.
//   4. AN OLD FORM CHANGING MEANING when it is first read through the new code.
//   5. INTERNALS REACHING A STRANGER — segments, campaigns, allowed websites in the public view.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    columnsFromDefinition, legacyToDefinition, normaliseFormDefinition, publicDefinition, validateAnswers,
    MAX_FIELDS, RESERVED_SLUGS,
} from '../src/utils/form-definition';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const norm = (raw: unknown, brand?: { accent?: string }) => normaliseFormDefinition(raw, { brand });

// ── 1. Style is tokens ──────────────────────────────────────────────────────

check('a colour that is not #rrggbb never survives', () => {
    const { definition: d } = norm({ style: { useBrandKit: false, accent: 'red; } body { display:none } .x {', background: 'url(javascript:x)', text: '#12345' } });
    assert.strictEqual(d.style.accent, '#059669');
    assert.strictEqual(d.style.background, '#ffffff');
    assert.strictEqual(d.style.text, '#111827');
});

check('enums fall back rather than pass through', () => {
    const { definition: d } = norm({ style: { font: 'Comic Sans"; }', radius: '99px', layout: 'grid' } });
    assert.deepStrictEqual([d.style.font, d.style.radius, d.style.layout], ['system', 'small', 'stacked']);
});

check('the brand kit wins while useBrandKit is on, and a chosen colour wins once it is off', () => {
    assert.strictEqual(norm({ style: { accent: '#ff0000' } }, { accent: '#0d9488' }).definition.style.accent, '#0d9488');
    assert.strictEqual(norm({ style: { accent: '#FF0000', useBrandKit: false } }, { accent: '#0d9488' }).definition.style.accent, '#ff0000');
});

check('the renderer re-checks every token too — a preview draws UNSAVED edits', () => {
    const r = read('subscribe.js');
    assert.match(r, /var HEX = \/\^#\[0-9a-f\]\{6\}\$\/i;/);
    assert.match(r, /function hex\(v, d\)/);
    assert.match(r, /pick\(FONTS, st\.font, 'system'\)/);
    assert.ok(!/st\.accent\s*\+/.test(r), 'a raw style value is never concatenated into CSS');
});

// ── 2. A form always collects something ─────────────────────────────────────

check('a form without an email gets one, and only one is allowed', () => {
    const none = norm({ fields: [{ type: 'text', label: 'Name', target: { kind: 'contact', column: 'first_name' } }] });
    assert.strictEqual(none.definition.fields[0].type, 'email');
    assert.ok(none.warnings.some((w) => /needs an email/.test(w)));
    const two = norm({ fields: [{ type: 'email', label: 'A' }, { type: 'email', label: 'B' }] });
    assert.strictEqual(two.definition.fields.filter((f) => f.type === 'email').length, 1);
    assert.strictEqual(two.definition.fields[0].required, true, 'email is always required');
});

check('a choice needs two options; a single checkbox is fine', () => {
    const { definition: d, warnings } = norm({ fields: [
        { type: 'select', label: 'Size', options: ['Only one'] },
        { type: 'checkbox', label: 'Send me the guide' },
    ] });
    assert.ok(!d.fields.some((f) => f.label === 'Size'));
    assert.ok(warnings.some((w) => /two choices/.test(w)));
    const cb = d.fields.find((f) => f.type === 'checkbox')!;
    assert.strictEqual(cb.options.length, 1);
});

check('two questions may not write to the same place', () => {
    const { definition: d } = norm({ fields: [
        { type: 'text', label: 'First', target: { kind: 'contact', column: 'first_name' } },
        { type: 'text', label: 'Given name', target: { kind: 'contact', column: 'first_name' } },
    ] });
    assert.strictEqual(d.fields.filter((f) => f.target.kind === 'contact' && f.target.column === 'first_name').length, 1);
});

check('a custom key is derived from the label when missing, and must match the DB check', () => {
    const { definition: d } = norm({ fields: [{ type: 'text', label: 'Team size?' }, { type: 'text', label: 'Role', target: { kind: 'custom', key: 'DROP TABLE' } }] });
    const keys = d.fields.filter((f) => f.target.kind === 'custom').map((f) => (f.target as { key: string }).key);
    assert.deepStrictEqual(keys, ['team_size', 'role']);
    for (const k of keys) assert.match(k, /^[a-z][a-z0-9_]{0,39}$/);
});

check(`at most ${MAX_FIELDS} questions`, () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ type: 'text', label: `Q${i}` }));
    assert.ok(norm({ fields: many }).definition.fields.length <= MAX_FIELDS);
});

check('sensitive questions are flagged', () => {
    assert.ok(norm({ fields: [{ type: 'text', label: 'Medical history' }] }).warnings.some((w) => /sensitive/.test(w)));
});

check('slugs: format, reserved words', () => {
    assert.strictEqual(norm({ delivery: { hosted: { slug: 'Pricing-Guide' } } }).definition.delivery.hosted.slug, 'pricing-guide');
    assert.strictEqual(norm({ delivery: { hosted: { slug: 'a b' } } }).definition.delivery.hosted.slug, null);
    assert.ok(RESERVED_SLUGS.has('admin'));
    assert.strictEqual(norm({ delivery: { hosted: { slug: 'admin' } } }).definition.delivery.hosted.slug, null);
});

check('a redirect must be http(s)', () => {
    const r = norm({ content: { redirectUrl: 'javascript:alert(1)' } });
    assert.strictEqual(r.definition.content.redirectUrl, null);
    assert.ok(r.warnings.length);
});

// ── 3. The server decides what is valid ─────────────────────────────────────

const quiz = norm({ fields: [
    { id: 'f_email', type: 'email', label: 'Email' },
    { id: 'f_size', type: 'select', label: 'Team size', required: true, options: [{ value: 'solo', label: 'Just me' }, { value: 'team', label: 'A team' }], target: { kind: 'custom', key: 'team_size' } },
    { id: 'f_topics', type: 'checkbox', label: 'Topics', options: ['Pricing', 'Hiring'], target: { kind: 'tag' } },
    { id: 'f_phone', type: 'phone', label: 'Phone', target: { kind: 'contact', column: 'phone' } },
], audience: { tags: ['From the guide'] } }).definition;

check('a required question must be answered', () => {
    const r = validateAnswers(quiz, { f_email: 'a@b.co' });
    assert.ok(!r.ok && /Team size/.test(r.error));
});

check('an option that is not on the form is dropped, and an unknown field is ignored', () => {
    const r = validateAnswers(quiz, { f_email: 'a@b.co', f_size: 'enterprise', f_topics: ['Pricing'], f_evil: 'x' });
    assert.ok(!r.ok, 'the only option given was invalid, so the required question is unanswered');
    const ok = validateAnswers(quiz, { f_email: 'a@b.co', f_size: 'team', f_topics: ['Pricing', 'Nope'], f_evil: 'x' });
    assert.ok(ok.ok);
    if (ok.ok) {
        assert.deepStrictEqual(ok.answers.custom, { team_size: 'A team' }, 'stored as the label a person reads');
        assert.deepStrictEqual(ok.answers.tags.sort(), ['From the guide', 'Pricing'].sort());
        assert.ok(!('f_evil' in ok.answers.stored));
        assert.strictEqual(ok.answers.email, 'a@b.co');
    }
});

check('a phone number must look like one', () => {
    const r = validateAnswers(quiz, { f_email: 'a@b.co', f_size: 'solo', f_phone: '<script>' });
    assert.ok(!r.ok);
});

// ── 4. Old forms keep their meaning ─────────────────────────────────────────

check('a pre-builder row reads as the same form', () => {
    const d = legacyToDefinition({
        name: 'Website', fields: ['email', 'first_name', 'company'], theme: { accent: '#123456', layout: 'stacked', buttonLabel: 'Join' },
        doubleOptIn: false, segmentId: 7, allowedOrigins: ['https://acme.com'], hostedEnabled: true,
        hostedHeadline: 'Join us', hostedIntro: 'Hi', consentText: 'OK?', successMessage: 'Done', redirectUrl: 'https://acme.com/thanks',
    });
    assert.deepStrictEqual(d.fields.map((f) => (f.target as { column?: string }).column), ['email', 'first_name', 'company']);
    assert.strictEqual(d.style.accent, '#123456', 'a colour somebody chose is kept, not replaced by the brand kit');
    assert.deepStrictEqual([d.audience.doubleOptIn, d.audience.segmentId], [false, 7]);
    assert.deepStrictEqual(d.delivery.embed.allowedOrigins, ['https://acme.com']);
    assert.deepStrictEqual([d.content.headline, d.content.buttonLabel, d.consent.text, d.content.redirectUrl],
        ['Join us', 'Join', 'OK?', 'https://acme.com/thanks']);
});

check('the derived columns agree with the definition they came from', () => {
    const cols = columnsFromDefinition(quiz);
    assert.deepStrictEqual(cols.fields, ['email', 'phone']);
    assert.strictEqual(cols.doubleOptIn, quiz.audience.doubleOptIn);
    assert.strictEqual(cols.consentText, quiz.consent.text);
    assert.strictEqual(cols.definition, quiz);
});

// ── 5. The public view ──────────────────────────────────────────────────────

check('a stranger sees content, fields and style — nothing internal', () => {
    const withSecrets = norm({ audience: { segmentId: 9, tags: ['vip'] }, campaign: { sequenceId: 4 }, delivery: { embed: { allowedOrigins: ['https://x.com'] } }, fields: quiz.fields }).definition;
    const pub = publicDefinition(withSecrets, { logoUrl: null, senderName: 'Acme' });
    const text = JSON.stringify(pub);
    for (const leak of ['segmentId', 'sequenceId', 'allowedOrigins', 'vip', 'target', 'team_size']) {
        assert.ok(!text.includes(leak), `"${leak}" must not reach the browser`);
    }
});

console.log(`\n${passed} checks passed.`);
