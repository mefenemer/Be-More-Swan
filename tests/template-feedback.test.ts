// tests/template-feedback.test.ts
// Plan §2.6 (the ⭐ option) — human edits to a drafted message become evidence.
//
// Two invariants, neither enforceable by the type system:
//
//   1. EDIT_REASONS is declared in THREE places (src/config/template-feedback.ts, db/schema.ts
//      check(), db/template-feedback-vocab.sql). It is the GROUP BY key for the entire
//      edit-pattern proposer, and recordTemplateEdit() swallows its errors — so a value added in
//      one place only becomes a CHECK violation inside a module that logs and returns null. That
//      failure is invisible: no error surfaces, evidence silently stops accumulating.
//
//   2. The agent's original draft must survive the first human edit. Without it there is no
//      before/after, `generated_body` records the human's text as the agent's, and the whole loop
//      has no input.
//
// No database: pure-function and cross-file-consistency checks, like tests/revenue-ledger.test.ts.
// Run:  npx tsx tests/template-feedback.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    EDIT_REASONS, EDIT_REASON_LABELS, EDIT_REASONS_FED_TO_MODEL, MIN_EDIT_SAMPLE, isEditReason,
} from '../src/config/template-feedback';
import { summariseEdit } from '../src/utils/template-feedback';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

// ── 1. Vocabulary integrity, across all three declarations ───────────────────

/** Pull the quoted values out of a CHECK-constraint style `IN (...)` list. */
function inListValues(text: string, after: string): string[] {
    const start = text.indexOf(after);
    assert.ok(start !== -1, `could not find "${after}"`);
    const open = text.indexOf('IN (', start);
    const close = text.indexOf(')', open);
    return [...text.slice(open, close).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

check('EDIT_REASON_LABELS covers exactly the vocabulary', () => {
    assert.deepEqual(Object.keys(EDIT_REASON_LABELS).sort(), [...EDIT_REASONS].sort());
    for (const [k, v] of Object.entries(EDIT_REASON_LABELS)) {
        assert.ok(v && v.trim(), `${k} has an empty label`);
    }
});

check('the SQL CHECK constraint lists exactly EDIT_REASONS', () => {
    const sql = read('db/template-feedback-vocab.sql');
    const values = inListValues(sql, 'ADD CONSTRAINT template_feedback_edit_reason_check');
    assert.deepEqual(
        values.sort(), [...EDIT_REASONS].sort(),
        'db/template-feedback-vocab.sql has drifted from src/config/template-feedback.ts',
    );
});

check('the SQL pre-flight guard checks the same list it constrains', () => {
    // The migration refuses to run if existing rows violate the vocabulary. If that guard's list
    // drifted from the constraint's, it would pass rows the ALTER then rejects — failing halfway
    // with a bare constraint error, which is exactly what the guard exists to prevent.
    const sql = read('db/template-feedback-vocab.sql');
    const guard = inListValues(sql, 'SELECT count(*) INTO bad');
    assert.deepEqual(guard.sort(), [...EDIT_REASONS].sort());
});

check('db/schema.ts check() lists exactly EDIT_REASONS', () => {
    const schema = read('db/schema.ts');
    const values = inListValues(schema, 'template_feedback_edit_reason_check');
    assert.deepEqual(
        values.sort(), [...EDIT_REASONS].sort(),
        'db/schema.ts has drifted — a later drizzle-kit push would revert the real constraint',
    );
});

check('`other` is captured but never fed to the model', () => {
    assert.ok((EDIT_REASONS as readonly string[]).includes('other'), 'the escape hatch must exist');
    assert.ok(
        !EDIT_REASONS_FED_TO_MODEL.includes('other' as never),
        '`other` is a bucket, not a signal — clustering on it gives the proposer nothing to act on',
    );
    assert.equal(EDIT_REASONS_FED_TO_MODEL.length, EDIT_REASONS.length - 1);
});

check('isEditReason rejects anything outside the vocabulary', () => {
    for (const r of EDIT_REASONS) assert.ok(isEditReason(r), `${r} should be valid`);
    for (const bad of ['', 'TOO_FORMAL', 'too formal', 'vibes', null, undefined, 7, {}]) {
        assert.ok(!isEditReason(bad), `${String(bad)} should be rejected`);
    }
});

check('MIN_EDIT_SAMPLE is above 1 — the whole point is not generalising from one edit', () => {
    assert.ok(MIN_EDIT_SAMPLE > 1, '§2.6 exists because "save as default" generalises from n = 1');
});

// ── 2. The diff summary ──────────────────────────────────────────────────────

check('a rewrite is distinguishable from a trim', () => {
    const before = { body: 'I am writing to enquire whether your organisation would be receptive to a discussion.' };
    const trimmed = { body: 'I am writing to enquire whether your organisation would be receptive.' };
    const rewritten = { body: 'Quick one — noticed you run four sites. Worth a chat?' };

    const t = summariseEdit(before, trimmed);
    const r = summariseEdit(before, rewritten);
    const pct = (s: string) => Number(/kept (\d+)%/.exec(s)?.[1] ?? -1);

    assert.ok(pct(t) > pct(r), `a trim should retain more wording than a rewrite (${t} vs ${r})`);
    assert.ok(pct(t) >= 0 && pct(r) >= 0, 'both summaries must report retention');
});

check('retention counts repeats once each, not as a set', () => {
    // A set intersection would score this as 100% retained, hiding that the message was gutted.
    const before = { body: 'follow up follow up follow up follow up' };
    const after = { body: 'follow up' };
    const kept = Number(/kept (\d+)%/.exec(summariseEdit(before, after))?.[1] ?? -1);
    assert.ok(kept > 0 && kept < 100, `expected partial retention, got ${kept}%`);
});

check('a subject change is reported on its own', () => {
    const s = summariseEdit(
        { subject: 'A partnership opportunity', body: 'Same body.' },
        { subject: 'Four sites, one rota', body: 'Same body.' },
    );
    assert.ok(/subject rewritten/.test(s), s);
});

check('an identical draft reports no measurable change', () => {
    const d = { subject: 'Hello', body: 'Same words entirely.' };
    assert.equal(summariseEdit(d, { ...d }), 'no measurable change');
});

check('an empty original never divides by zero', () => {
    const s = summariseEdit({ body: '' }, { body: 'Now there is something here.' });
    assert.ok(s && !/NaN|Infinity/.test(s), s);
});

// ── 3. Single writer + the observer contract ─────────────────────────────────

check('template_feedback has exactly one writer', () => {
    for (const f of ['netlify/functions/lead-generation.ts', 'src/components/assistant-data-hub.js']) {
        assert.ok(
            !/insert\s*\(\s*templateFeedback/.test(read(f)),
            `${f} inserts into templateFeedback directly — route through recordTemplateEdit()`,
        );
    }
    const util = read('src/utils/template-feedback.ts');
    assert.equal(
        (util.match(/insert\(templateFeedback\)/g) ?? []).length, 1,
        'src/utils/template-feedback.ts should contain the single insert',
    );
});

check('recordTemplateEdit never throws', () => {
    const util = read('src/utils/template-feedback.ts');
    const fn = util.slice(util.indexOf('export async function recordTemplateEdit'));
    assert.ok(/try\s*{/.test(fn) && /catch\s*\(/.test(fn), 'must swallow — the edit already shipped');
    assert.ok(
        /return null/.test(fn),
        'failure must resolve to null so a feedback error cannot fail a successful edit',
    );
});

check('the feedback action refuses a draft that was never edited', () => {
    const src = read('netlify/functions/lead-generation.ts');
    const action = src.slice(src.indexOf("if (action === 'record_edit_feedback')"));
    assert.ok(
        /has not been edited/.test(action.slice(0, action.indexOf('return json(200'))),
        'a feedback row with no diff would inflate the sample count the proposer gates on',
    );
});

// ── 4. The agent's original draft survives the edit ──────────────────────────

check('saveEmail stashes the original draft exactly once', () => {
    const js = read('assistants.js');
    const branch = js.slice(js.indexOf("if (action === 'saveEmail')"));
    const body = branch.slice(0, branch.indexOf('_rqPendingEdit ='));
    assert.ok(/draftOriginal/.test(body), 'saveEmail must preserve the agent draft');
    assert.ok(
        /if\s*\(!\(rec\.data \|\| \{\}\)\.draftOriginal\)/.test(body),
        'must stash only on the FIRST edit — a second edit would otherwise overwrite the agent\'s '
        + 'text with the human\'s first attempt',
    );
});

check('the send path prefers the stashed original as generatedBody', () => {
    const src = read('netlify/functions/lead-generation.ts');
    const idx = src.indexOf('recordOutboundMessage(db, thread.id');
    const block = src.slice(idx - 900, idx + 400);
    assert.ok(/draftOriginal/.test(block), 'generatedBody must be the AGENT text, not the human edit');
    assert.ok(
        /generatedBody,/.test(block) && !/generatedBody: bodyText/.test(block),
        'generatedBody must no longer be hardcoded to the outgoing body',
    );
});

check('a failed save clears the pending-edit flag', () => {
    const js = read('assistants.js');
    const act = js.slice(js.indexOf('window._detailRqRecordAct'));
    const scope = act.slice(0, act.indexOf('\n};'));
    const catchBlock = scope.slice(scope.lastIndexOf('} catch (e) {'));
    assert.ok(
        /_rqPendingEdit = null/.test(catchBlock),
        'left set, the strip would surface on the NEXT action — asking why the user changed a draft '
        + 'they did not change',
    );
});

console.log(`\n${passed} checks passed.`);
